//! pdf.js, through js/pdf-bridge.mjs. `#[wasm_bindgen(module = …)]` makes
//! wasm-bindgen copy that file into the build ("snippets") and import it; the
//! document handle stays an opaque JsValue that only the bridge looks inside.

use crate::js::{error, from_js, Res};
use js_sys::Promise;
use reader_core::outline::{flatten_outline, FlatOutlineItem, RawOutlineItem};
use serde::Deserialize;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen(module = "/js/pdf-bridge.mjs")]
extern "C" {
    #[wasm_bindgen(js_name = openPdf)]
    fn open_pdf(bytes: &js_sys::Uint8Array) -> Promise;
    #[wasm_bindgen(js_name = pageSize)]
    fn page_size(doc: &JsValue, n: u32) -> Promise;
    #[wasm_bindgen(js_name = outline)]
    fn raw_outline(doc: &JsValue) -> Promise;
    #[wasm_bindgen(js_name = title)]
    fn doc_title(doc: &JsValue) -> Promise;
    #[wasm_bindgen(js_name = pageTexts)]
    fn page_texts_js(doc: &JsValue) -> Promise;
    #[wasm_bindgen(js_name = pageLines)]
    fn page_lines_js(doc: &JsValue) -> Promise;
    #[wasm_bindgen(js_name = renderPage)]
    pub fn render_page(
        doc: &JsValue,
        n: u32,
        canvas: &web_sys::HtmlCanvasElement,
        scale: f64,
        thumb: bool,
        recolor: &js_sys::Function,
    ) -> JsValue;
    #[wasm_bindgen(js_name = textLayer)]
    pub fn text_layer(
        doc: &JsValue,
        n: u32,
        container: &web_sys::HtmlElement,
        scale: f64,
    ) -> JsValue;
    #[wasm_bindgen(js_name = pageLinks)]
    fn page_links_js(doc: &JsValue, n: u32, scale: f64) -> Promise;
    #[wasm_bindgen(js_name = resolveDest)]
    fn resolve_dest_js(doc: &JsValue, dest: &JsValue) -> Promise;
}

thread_local! {
    static RECOLOR: js_sys::Function = {
        // The theme's tokens, read once: the stylesheet is the one source of the colours.
        let token = |name: &str| {
            web_sys::window()
                .and_then(|w| w.document())
                .and_then(|d| d.document_element())
                .and_then(|el| web_sys::window()?.get_computed_style(&el).ok().flatten())
                .and_then(|s| s.get_property_value(name).ok())
                .and_then(|v| reader_core::recolor::parse_hex(&v))
        };
        let ink = token("--pdf-ink").unwrap_or([0xf3, 0xe8, 0xd6]);
        let paper = token("--pdf-paper").unwrap_or([0x26, 0x1c, 0x16]);
        let f = Closure::<dyn Fn(js_sys::Uint8ClampedArray, u32, js_sys::Float64Array)>::new(
            move |data: js_sys::Uint8ClampedArray, width: u32, boxes: js_sys::Float64Array| {
                let mut px = data.to_vec();
                let images: Vec<_> = boxes
                    .to_vec()
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|b| {
                        let x = b[0].max(0.0).floor();
                        let y = b[1].max(0.0).floor();
                        (x as usize, y as usize, (b[2] + b[0] - x).ceil() as usize, (b[3] + b[1] - y).ceil() as usize)
                    })
                    .collect();
                reader_core::recolor::recolor(&mut px, width as usize, &images, ink, paper);
                data.copy_from(&px);
            },
        );
        // One closure for the page's lifetime, shared by every render.
        f.into_js_value().unchecked_into()
    };
}

/// The walnut page: what `renderPage` runs on every page's pixels.
pub fn recolor_fn() -> js_sys::Function {
    RECOLOR.with(Clone::clone)
}

/// A `{ promise, cancel }` task from the bridge: cancel it on unmount.
pub fn cancel(task: &JsValue) {
    if let Ok(f) =
        js_sys::Reflect::get(task, &"cancel".into()).and_then(|f| f.dyn_into::<js_sys::Function>())
    {
        let _ = f.call0(task);
    }
}

pub async fn finished(task: &JsValue) {
    if let Ok(p) =
        js_sys::Reflect::get(task, &"promise".into()).and_then(|p| p.dyn_into::<Promise>())
    {
        let _ = JsFuture::from(p).await;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct PageSize {
    pub width: f64,
    pub height: f64,
}

/// Documents up to this many pages are sized before the reader opens.
const EAGER_SIZE_PAGES: u32 = 300;

pub struct Opened {
    pub doc: JsValue,
    pub sizes: Vec<PageSize>,
    /// True when `sizes` is page 1's size repeated, to be corrected later
    pub progressive: bool,
    pub outline: Vec<FlatOutlineItem>,
    pub title: String,
}

#[derive(Default, Deserialize)]
struct BridgeItem {
    title: String,
    page: Option<u32>,
    items: Vec<BridgeItem>,
}

fn to_raw(items: Vec<BridgeItem>) -> Vec<RawOutlineItem<Option<u32>>> {
    items
        .into_iter()
        .map(|i| RawOutlineItem {
            title: i.title,
            dest: i.page,
            items: to_raw(i.items),
        })
        .collect()
}

pub fn num_pages(doc: &JsValue) -> u32 {
    js_sys::Reflect::get(doc, &"numPages".into())
        .ok()
        .and_then(|n| n.as_f64())
        .unwrap_or(0.0) as u32
}

/// Fetch and open a PDF. A non-PDF answer (a paywall page behind a .pdf link)
/// is an error message, not a parser crash.
pub async fn open(src: &str) -> Result<Opened, String> {
    let init =
        crate::js::to_js(&serde_json::json!({ "credentials": "include" })).map_err(|_| "init")?;
    let res: web_sys::Response =
        JsFuture::from(crate::chrome::fetch(src, &init).map_err(|_| "Couldn't download the PDF.")?)
            .await
            .map_err(|_| "Couldn't download the PDF. Failed to fetch".to_string())?
            .unchecked_into();
    if !res.ok() {
        return Err(format!(
            "Couldn't download the PDF. The server answered {}.",
            res.status()
        ));
    }
    let buffer = JsFuture::from(res.array_buffer().map_err(|_| "body")?)
        .await
        .map_err(|_| "Couldn't download the PDF.")?;
    let bytes = js_sys::Uint8Array::new(&buffer);
    // The spec allows junk before the header; %PDF- in the first 1 KB is the leniency real viewers apply.
    let head = bytes.subarray(0, bytes.length().min(1024)).to_vec();
    if !head.windows(5).any(|w| w == b"%PDF-") {
        return Err("This link didn't return a PDF (probably a login or landing page).".into());
    }
    let doc = JsFuture::from(open_pdf(&bytes))
        .await
        .map_err(|e| format!("Couldn't open the PDF. {}", js_message(&e)))?;
    let n = num_pages(&doc);
    let progressive = n > EAGER_SIZE_PAGES;
    let sizes = if progressive {
        let first = size_of(&doc, 1)
            .await
            .map_err(|_| "Couldn't open the PDF.")?;
        vec![first; n as usize]
    } else {
        all_sizes(&doc)
            .await
            .map_err(|_| "Couldn't open the PDF.")?
    };
    let items: Vec<BridgeItem> = match JsFuture::from(raw_outline(&doc)).await {
        Ok(v) => from_js(v).unwrap_or_default(),
        Err(_) => vec![],
    };
    let outline = flatten_outline(&to_raw(items), |page| *page);
    let title = JsFuture::from(doc_title(&doc))
        .await
        .ok()
        .and_then(|t| t.as_string())
        .unwrap_or_default();
    Ok(Opened {
        doc,
        sizes,
        progressive,
        outline,
        title,
    })
}

fn js_message(e: &JsValue) -> String {
    e.dyn_ref::<js_sys::Error>()
        .map(|e| String::from(e.message()))
        .unwrap_or_default()
}

async fn size_of(doc: &JsValue, n: u32) -> Res<PageSize> {
    from_js(JsFuture::from(page_size(doc, n)).await?)
}

/// Every page's size (~0.4 ms each in the worker).
pub async fn all_sizes(doc: &JsValue) -> Res<Vec<PageSize>> {
    let mut sizes = Vec::new();
    for n in 1..=num_pages(doc) {
        sizes.push(size_of(doc, n).await?);
    }
    Ok(sizes)
}

pub async fn page_texts(doc: &JsValue) -> Res<Vec<String>> {
    from_js(JsFuture::from(page_texts_js(doc)).await?)
}

#[derive(Deserialize)]
struct Line {
    text: String,
    y: f64,
}

pub async fn page_lines(doc: &JsValue) -> Res<Vec<Vec<(String, f64)>>> {
    let pages: Vec<Vec<Line>> = from_js(JsFuture::from(page_lines_js(doc)).await?)?;
    Ok(pages
        .into_iter()
        .map(|lines| lines.into_iter().map(|l| (l.text, l.y)).collect())
        .collect())
}

#[derive(Debug, Clone, Deserialize)]
pub struct Link {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub url: Option<String>,
}

/// Link annotations with their raw dest JsValues (refs don't survive JSON).
pub async fn page_links(doc: &JsValue, n: u32, scale: f64) -> Res<Vec<(Link, JsValue)>> {
    let raw = JsFuture::from(page_links_js(doc, n, scale)).await?;
    let arr: js_sys::Array = raw.dyn_into().map_err(|_| error("links"))?;
    Ok(arr
        .iter()
        .filter_map(|item| {
            // Dests are names or arrays of pdf.js object refs, which don't survive JSON:
            // kept as the raw JsValue beside the parsed box.
            let dest = js_sys::Reflect::get(&item, &"dest".into()).unwrap_or(JsValue::NULL);
            let _ = js_sys::Reflect::set(&item, &"dest".into(), &JsValue::NULL);
            from_js::<Link>(item).ok().map(|l| (l, dest))
        })
        .collect())
}

pub async fn resolve_dest(doc: &JsValue, dest: &JsValue) -> Option<(u32, f64)> {
    #[derive(Deserialize)]
    struct Pos {
        page: u32,
        offset: f64,
    }
    let v = JsFuture::from(resolve_dest_js(doc, dest)).await.ok()?;
    from_js::<Option<Pos>>(v)
        .ok()
        .flatten()
        .map(|p| (p.page, p.offset))
}
