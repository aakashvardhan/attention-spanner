//! The themed page: a rendered PDF page's greys mapped onto paper-to-ink, so
//! black-on-white becomes the palette's `--pdf-ink` on `--pdf-paper`. Photos
//! and other embedded images (their boxes come from the page's operator list)
//! are left alone. Coloured marks (plot lines, coloured links) keep their hue,
//! but their anti-aliased edges were blended with white paper: each is unmixed
//! from white and laid back over the page's paper, or links wear a pale halo
//! and read blurry.

/// A pixel box on the canvas: x, y, width, height.
pub type PixelBox = (usize, usize, usize, usize);

/// How far apart a pixel's channels may be and still count as grey.
/// ponytail: a fixed chroma cut; tune if near-grey colour gets flattened.
const GREY_SPREAD: u8 = 40;
/// How far a recovered colour is lifted toward white on dark paper (the grid
/// palette): a PDF's dark blue link would otherwise land near-black on
/// near-black. Light paper keeps colours exact; they are legible as printed.
const DARK_PAPER_LIFT: f64 = 0.3;

/// The lift for this paper: none on light paper, `DARK_PAPER_LIFT` on dark.
fn colour_lift(paper: [u8; 3]) -> f64 {
    let luma =
        0.299 * f64::from(paper[0]) + 0.587 * f64::from(paper[1]) + 0.114 * f64::from(paper[2]);
    if luma < 128.0 {
        DARK_PAPER_LIFT
    } else {
        0.0
    }
}

/// `#rrggbb` to bytes; `None` for anything else.
pub fn parse_hex(s: &str) -> Option<[u8; 3]> {
    let h = s.trim().strip_prefix('#')?;
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let b = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some([b(0)?, b(2)?, b(4)?])
}

fn duotone(px: &mut [u8; 4], ink: [u8; 3], paper: [u8; 3], lift: f64) {
    let (r, g, b) = (px[0], px[1], px[2]);
    if r.max(g).max(b) - r.min(g).min(b) > GREY_SPREAD {
        // Coverage over white paper: the whitest channel says how much white is mixed in.
        let a = 1.0 - f64::from(r.min(g).min(b)) / 255.0;
        for c in 0..3 {
            let solid = (f64::from(px[c]) - 255.0 * (1.0 - a)) / a;
            let solid = solid + (255.0 - solid) * lift;
            px[c] = (solid * a + f64::from(paper[c]) * (1.0 - a))
                .round()
                .clamp(0.0, 255.0) as u8;
        }
        return;
    }
    // White → paper, black → ink.
    let dark = 1.0 - (0.299 * f64::from(r) + 0.587 * f64::from(g) + 0.114 * f64::from(b)) / 255.0;
    for c in 0..3 {
        let (p, i) = (f64::from(paper[c]), f64::from(ink[c]));
        px[c] = (p + (i - p) * dark).round() as u8;
    }
}

/// Recolour RGBA pixels in place, leaving everything inside `images` untouched.
pub fn recolor(rgba: &mut [u8], width: usize, images: &[PixelBox], ink: [u8; 3], paper: [u8; 3]) {
    if width == 0 {
        return;
    }
    let lift = colour_lift(paper);
    for (y, row) in rgba.chunks_exact_mut(width * 4).enumerate() {
        let spans: Vec<(usize, usize)> = images
            .iter()
            .filter(|(_, by, _, bh)| y >= *by && y < by + bh)
            .map(|(bx, _, bw, _)| (*bx, bx + bw))
            .collect();
        for (x, px) in row.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            if !spans.iter().any(|(a, b)| x >= *a && x < *b) {
                duotone(px, ink, paper, lift);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A dark page (light ink on dark paper), so recovered colour is lifted.
    const INK: [u8; 3] = [0xf3, 0xe8, 0xd6];
    const PAPER: [u8; 3] = [0x26, 0x1c, 0x16];
    // The default light palette's tokens (theme.css).
    const LIGHT_INK: [u8; 3] = [0x1d, 0x18, 0x13];
    const LIGHT_PAPER: [u8; 3] = [0xe9, 0xe2, 0xd5];

    #[test]
    fn white_becomes_paper_and_black_becomes_ink() {
        let mut px = [255, 255, 255, 255, 0, 0, 0, 255];
        recolor(&mut px, 2, &[], INK, PAPER);
        assert_eq!(&px[..3], &PAPER);
        assert_eq!(&px[4..7], &INK);
        assert_eq!((px[3], px[7]), (255, 255), "alpha is left alone");
    }

    #[test]
    fn colour_keeps_its_hue_and_images_keep_their_true_colour() {
        // Row 0: a solid blue link pixel, then a white image pixel. Row 1: a
        // half-white blue edge pixel, then white outside any image.
        let mut px = [
            0, 0, 255, 255, 255, 255, 255, 255, //
            128, 128, 255, 255, 255, 255, 255, 255,
        ];
        recolor(&mut px, 2, &[(1, 0, 1, 1)], INK, PAPER);
        let lifted = (255.0 * DARK_PAPER_LIFT).round() as u8;
        assert_eq!(
            &px[..3],
            &[lifted, lifted, 255],
            "solid colour: hue kept, lifted"
        );
        assert_eq!(&px[4..7], &[255, 255, 255], "inside an image: untouched");
        // The edge sits between the paper and the solid colour, not near white.
        let edge = &px[8..11];
        assert!(edge[0] < 80 && edge[1] < 80, "no pale halo: {edge:?}");
        assert!(edge[2] > PAPER[2] && edge[2] < 255);
        assert_eq!(&px[12..15], &PAPER);
    }

    #[test]
    fn light_paper_keeps_colour_exact_and_dark_paper_lifts_it() {
        let mut px = [0, 0, 255, 255];
        recolor(&mut px, 1, &[], LIGHT_INK, LIGHT_PAPER);
        assert_eq!(&px[..3], &[0, 0, 255], "light paper: no lift");
        // The grid palette's paper (#0a121b): a dark link is lifted off it.
        let mut px = [0, 0, 128, 255];
        recolor(&mut px, 1, &[], [0xd8, 0xfb, 0xff], [0x0a, 0x12, 0x1b]);
        assert!(px[0] >= 70 && px[1] >= 70 && px[2] > 128, "{px:?}");
        assert!(px[2] > px[0], "hue kept: {px:?}");
    }

    #[test]
    fn parses_tokens() {
        assert_eq!(parse_hex(" #261c16"), Some(PAPER));
        assert_eq!(parse_hex("rgba(0,0,0,1)"), None);
        assert_eq!(parse_hex("#fff"), None);
        // Six bytes that are not six hex digits: no panic, no sign accepted.
        assert_eq!(parse_hex("#a€bc"), None);
        assert_eq!(parse_hex("#+f+f+f"), None);
    }
}
