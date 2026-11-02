//! The walnut page: a rendered PDF page's greys mapped onto paper-to-ink, so
//! black-on-white becomes cream-on-walnut. Photos and other embedded images
//! (their boxes come from the page's operator list) and coloured marks (plot
//! lines, coloured links) keep their true colour.

/// A pixel box on the canvas: x, y, width, height.
pub type PixelBox = (usize, usize, usize, usize);

/// How far apart a pixel's channels may be and still count as grey.
/// ponytail: a fixed chroma cut; pastel fills in vector figures read as colour and stay light.
const GREY_SPREAD: u8 = 40;

/// `#rrggbb` to bytes; `None` for anything else.
pub fn parse_hex(s: &str) -> Option<[u8; 3]> {
    let h = s.trim().strip_prefix('#')?;
    if h.len() != 6 {
        return None;
    }
    let b = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some([b(0)?, b(2)?, b(4)?])
}

fn duotone(px: &mut [u8; 4], ink: [u8; 3], paper: [u8; 3]) {
    let (r, g, b) = (px[0], px[1], px[2]);
    if r.max(g).max(b) - r.min(g).min(b) > GREY_SPREAD {
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
    for (y, row) in rgba.chunks_exact_mut(width * 4).enumerate() {
        let spans: Vec<(usize, usize)> = images
            .iter()
            .filter(|(_, by, _, bh)| y >= *by && y < by + bh)
            .map(|(bx, _, bw, _)| (*bx, bx + bw))
            .collect();
        for (x, px) in row.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            if !spans.iter().any(|(a, b)| x >= *a && x < *b) {
                duotone(px, ink, paper);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INK: [u8; 3] = [0xf3, 0xe8, 0xd6];
    const PAPER: [u8; 3] = [0x26, 0x1c, 0x16];

    #[test]
    fn white_becomes_paper_and_black_becomes_ink() {
        let mut px = [255, 255, 255, 255, 0, 0, 0, 255];
        recolor(&mut px, 2, &[], INK, PAPER);
        assert_eq!(&px[..3], &PAPER);
        assert_eq!(&px[4..7], &INK);
        assert_eq!((px[3], px[7]), (255, 255), "alpha is left alone");
    }

    #[test]
    fn colour_and_images_keep_their_true_colour() {
        // Row 0: a red plot line, then white. Row 1: white inside an image box, then white outside.
        let mut px = [
            220, 30, 30, 255, 255, 255, 255, 255, //
            255, 255, 255, 255, 255, 255, 255, 255,
        ];
        recolor(&mut px, 2, &[(0, 1, 1, 1)], INK, PAPER);
        assert_eq!(&px[..3], &[220, 30, 30]);
        assert_eq!(&px[4..7], &PAPER);
        assert_eq!(&px[8..11], &[255, 255, 255]);
        assert_eq!(&px[12..15], &PAPER);
    }

    #[test]
    fn parses_tokens() {
        assert_eq!(parse_hex(" #261c16"), Some(PAPER));
        assert_eq!(parse_hex("rgba(0,0,0,1)"), None);
        assert_eq!(parse_hex("#fff"), None);
    }
}
