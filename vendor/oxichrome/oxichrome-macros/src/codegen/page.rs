use proc_macro2::TokenStream;
use quote::{format_ident, quote};
use syn::punctuated::Punctuated;
use syn::{Expr, ExprLit, ItemFn, Lit, Meta, MetaNameValue, Token};

/// `#[oxichrome::page(path = "pages/reader.html", title = "Reader", css = ["theme.css"])]`
///
/// A Leptos component mounted on its own extension page. The build writes the
/// HTML shell at `path` and a loader beside it; this macro only exports the
/// mount function the loader calls. `path` is checked here so a typo fails the
/// compile instead of producing a page that 404s.
pub fn expand(attr: TokenStream, item: TokenStream) -> Result<TokenStream, syn::Error> {
    let args = syn::parse::Parser::parse2(Punctuated::<Meta, Token![,]>::parse_terminated, attr.clone())?;
    let mut path = None;
    for meta in &args {
        if let Meta::NameValue(MetaNameValue { path: key, value, .. }) = meta {
            if key.is_ident("path") {
                if let Expr::Lit(ExprLit { lit: Lit::Str(s), .. }) = value {
                    path = Some(s.clone());
                }
            } else if !(key.is_ident("title") || key.is_ident("css")) {
                return Err(syn::Error::new_spanned(key, "unknown page argument; expected `path`, `title` or `css`"));
            }
        }
    }
    let path = path.ok_or_else(|| syn::Error::new_spanned(&attr, "a page needs `path = \"…/name.html\"`"))?;
    let value = path.value();
    if value.starts_with('/') || !value.ends_with(".html") || value.contains("..") {
        return Err(syn::Error::new_spanned(&path, "page `path` must be relative, inside the extension, and end in `.html`"));
    }

    let func: ItemFn = syn::parse2(item)?;
    let fn_name = &func.sig.ident;
    let fn_body = &func.block;
    let vis = &func.vis;
    let attrs = &func.attrs;
    let ret = &func.sig.output;
    let mount = format_ident!("__oxichrome_mount_page_{}", fn_name.to_string().to_lowercase());

    Ok(quote! {
        #(#attrs)*
        #[::leptos::component]
        #vis fn #fn_name() #ret #fn_body

        #[doc(hidden)]
        #[oxichrome::__private::wasm_bindgen::prelude::wasm_bindgen]
        pub fn #mount() {
            let handle = ::leptos::mount::mount_to_body(#fn_name);
            std::mem::forget(handle);
        }
    })
}
