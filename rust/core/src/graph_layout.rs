//! A force-directed layout for the lexicon graph, in the style of d3-force:
//! nodes repel, edges pull like springs, everything drifts to the centre, and
//! `alpha` cools each tick until the graph is still. Pure, so a page can tick
//! it per animation frame and a test can tick it to rest.

/// Below this the graph is still and the page stops ticking.
const ALPHA_MIN: f64 = 0.001;
/// Per tick, alpha moves this fraction of the way to its target.
const ALPHA_DECAY: f64 = 0.0228;
/// Fraction of velocity kept each tick.
const VELOCITY_KEEP: f64 = 0.6;
const REPULSION: f64 = 4000.0;
const LINK_LENGTH: f64 = 70.0;
const LINK_STRENGTH: f64 = 0.3;
const CENTRING: f64 = 0.02;
/// Two nodes nearer than this repel as if this far, so a stack never explodes.
const MIN_DISTANCE: f64 = 8.0;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct P {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Sim {
    pub nodes: Vec<P>,
    pub links: Vec<(usize, usize)>,
    pub alpha: f64,
    target: f64,
}

impl Sim {
    /// Nodes laid out on a sunflower spiral (deterministic, evenly spread),
    /// turned by `seed` so two lexicons do not start identically.
    pub fn new(n: usize, links: Vec<(usize, usize)>, seed: u32) -> Sim {
        let golden = std::f64::consts::PI * (3.0 - 5f64.sqrt());
        let turn = f64::from(seed % 360).to_radians();
        let nodes = (0..n)
            .map(|i| {
                let r = 30.0 * ((i as f64) + 0.5).sqrt();
                let a = (i as f64) * golden + turn;
                P {
                    x: r * a.cos(),
                    y: r * a.sin(),
                    ..P::default()
                }
            })
            .collect();
        let links = links
            .into_iter()
            .filter(|&(a, b)| a != b && a < n && b < n)
            .collect();
        Sim {
            nodes,
            links,
            alpha: 1.0,
            target: 0.0,
        }
    }

    pub fn settled(&self) -> bool {
        self.alpha < ALPHA_MIN && self.target == 0.0
    }

    /// Warm the layout up again (a drag, a new term).
    pub fn reheat(&mut self, alpha: f64) {
        self.alpha = self.alpha.max(alpha);
    }

    /// While dragging, alpha holds warm so the neighbours follow.
    pub fn hold_warm(&mut self, on: bool) {
        self.target = if on { 0.3 } else { 0.0 };
        if on {
            self.reheat(0.3);
        }
    }

    pub fn drag_to(&mut self, i: usize, x: f64, y: f64) {
        if let Some(p) = self.nodes.get_mut(i) {
            *p = P {
                x,
                y,
                vx: 0.0,
                vy: 0.0,
                pinned: true,
            };
        }
    }

    pub fn release(&mut self, i: usize) {
        if let Some(p) = self.nodes.get_mut(i) {
            p.pinned = false;
        }
    }

    pub fn tick(&mut self) {
        self.alpha += (self.target - self.alpha) * ALPHA_DECAY;
        let alpha = self.alpha;
        let n = self.nodes.len();
        // ponytail: O(n²) repulsion, fine below ~400 terms; Barnes-Hut if the lexicon outgrows it.
        for i in 0..n {
            for j in (i + 1)..n {
                let (a, b) = (self.nodes[i], self.nodes[j]);
                let (mut dx, mut dy) = (b.x - a.x, b.y - a.y);
                if dx == 0.0 && dy == 0.0 {
                    // Coincident: push apart along a fixed direction per pair.
                    let a = (i * 31 + j * 17) as f64;
                    (dx, dy) = (a.cos(), a.sin());
                }
                let d2 = (dx * dx + dy * dy).max(MIN_DISTANCE * MIN_DISTANCE);
                let d = d2.sqrt();
                let f = REPULSION * alpha / d2;
                let (fx, fy) = (dx / d * f, dy / d * f);
                self.nodes[i].vx -= fx;
                self.nodes[i].vy -= fy;
                self.nodes[j].vx += fx;
                self.nodes[j].vy += fy;
            }
        }
        for &(i, j) in &self.links {
            let (a, b) = (self.nodes[i], self.nodes[j]);
            let (dx, dy) = (b.x - a.x, b.y - a.y);
            let d = (dx * dx + dy * dy).sqrt().max(MIN_DISTANCE);
            let f = (d - LINK_LENGTH) / d * LINK_STRENGTH * alpha;
            let (fx, fy) = (dx * f, dy * f);
            self.nodes[i].vx += fx;
            self.nodes[i].vy += fy;
            self.nodes[j].vx -= fx;
            self.nodes[j].vy -= fy;
        }
        for p in &mut self.nodes {
            if p.pinned {
                p.vx = 0.0;
                p.vy = 0.0;
                continue;
            }
            p.vx -= p.x * CENTRING * alpha;
            p.vy -= p.y * CENTRING * alpha;
            p.vx *= VELOCITY_KEEP;
            p.vy *= VELOCITY_KEEP;
            p.x += p.vx;
            p.y += p.vy;
        }
    }

    /// Tick until still (bounded), for reduced motion and the first paint.
    pub fn settle(&mut self) {
        for _ in 0..1000 {
            if self.settled() {
                break;
            }
            self.tick();
        }
    }

    /// The box holding every node, padded; `(x, y, w, h)`.
    pub fn bounds(&self, pad: f64) -> (f64, f64, f64, f64) {
        if self.nodes.is_empty() {
            return (-pad, -pad, 2.0 * pad, 2.0 * pad);
        }
        let xs = self.nodes.iter().map(|p| p.x);
        let ys = self.nodes.iter().map(|p| p.y);
        let (x0, x1) = (
            xs.clone().fold(f64::INFINITY, f64::min),
            xs.fold(f64::NEG_INFINITY, f64::max),
        );
        let (y0, y1) = (
            ys.clone().fold(f64::INFINITY, f64::min),
            ys.fold(f64::NEG_INFINITY, f64::max),
        );
        (x0 - pad, y0 - pad, x1 - x0 + 2.0 * pad, y1 - y0 + 2.0 * pad)
    }
}

/// Where the page looks: the layout point at the stage's centre, and pixels per unit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cam {
    pub cx: f64,
    pub cy: f64,
    pub k: f64,
}

pub const ZOOM_MIN: f64 = 0.25;
pub const ZOOM_MAX: f64 = 3.0;

impl Default for Cam {
    fn default() -> Self {
        Cam {
            cx: 0.0,
            cy: 0.0,
            k: 1.0,
        }
    }
}

impl Cam {
    /// Every node inside a `w`×`h` stage with `pad` px to spare, zoom clamped.
    pub fn fit(sim: &Sim, w: f64, h: f64, pad: f64) -> Cam {
        let (x, y, bw, bh) = sim.bounds(0.0);
        let room = |px: f64, span: f64| (px - 2.0 * pad).max(1.0) / span.max(1.0);
        Cam {
            cx: x + bw / 2.0,
            cy: y + bh / 2.0,
            k: room(w, bw).min(room(h, bh)).clamp(ZOOM_MIN, ZOOM_MAX),
        }
    }

    /// Layout point → stage px.
    pub fn to_screen(self, x: f64, y: f64, w: f64, h: f64) -> (f64, f64) {
        (
            (x - self.cx) * self.k + w / 2.0,
            (y - self.cy) * self.k + h / 2.0,
        )
    }

    /// Stage px → layout point.
    pub fn to_layout(self, sx: f64, sy: f64, w: f64, h: f64) -> (f64, f64) {
        (
            (sx - w / 2.0) / self.k + self.cx,
            (sy - h / 2.0) / self.k + self.cy,
        )
    }

    /// Zoom by `factor`, keeping the point under (`sx`, `sy`) still.
    pub fn zoom_at(self, factor: f64, sx: f64, sy: f64, w: f64, h: f64) -> Cam {
        let (ux, uy) = self.to_layout(sx, sy, w, h);
        let k = (self.k * factor).clamp(ZOOM_MIN, ZOOM_MAX);
        Cam {
            cx: ux - (sx - w / 2.0) / k,
            cy: uy - (sy - h / 2.0) / k,
            k,
        }
    }

    /// Part way from `self` to `to`, `t` in 0..=1.
    pub fn lerp(self, to: Cam, t: f64) -> Cam {
        let m = |a: f64, b: f64| a + (b - a) * t;
        Cam {
            cx: m(self.cx, to.cx),
            cy: m(self.cy, to.cy),
            k: m(self.k, to.k),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finite(s: &Sim) -> bool {
        s.nodes.iter().all(|p| p.x.is_finite() && p.y.is_finite())
    }

    fn dist(s: &Sim, i: usize, j: usize) -> f64 {
        let (a, b) = (s.nodes[i], s.nodes[j]);
        ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
    }

    #[test]
    fn the_same_seed_gives_the_same_layout() {
        let mut a = Sim::new(12, vec![(0, 1), (2, 3)], 7);
        let mut b = Sim::new(12, vec![(0, 1), (2, 3)], 7);
        a.settle();
        b.settle();
        assert_eq!(a, b);
        assert_ne!(Sim::new(12, vec![], 7).nodes, Sim::new(12, vec![], 8).nodes);
    }

    #[test]
    fn tiny_and_stacked_graphs_stay_finite() {
        for n in 0..3 {
            let mut s = Sim::new(n, vec![(0, 1)], 0);
            s.settle();
            assert!(finite(&s) && s.settled(), "n = {n}");
        }
        let mut s = Sim::new(5, vec![(0, 1), (1, 1), (3, 99)], 0);
        assert_eq!(s.links, vec![(0, 1)]);
        for p in &mut s.nodes {
            (p.x, p.y) = (0.0, 0.0);
        }
        s.settle();
        assert!(finite(&s));
        assert!(dist(&s, 2, 3) > 1.0);
        let (x, y, w, h) = s.bounds(10.0);
        assert!(s
            .nodes
            .iter()
            .all(|p| p.x > x && p.x < x + w && p.y > y && p.y < y + h));
        assert_eq!(Sim::new(0, vec![], 0).bounds(5.0), (-5.0, -5.0, 10.0, 10.0));
    }

    #[test]
    fn settles_in_bounded_ticks() {
        let links = (0..199).map(|i| (i, i + 1)).collect();
        let mut s = Sim::new(200, links, 3);
        let mut ticks = 0;
        while !s.settled() {
            s.tick();
            ticks += 1;
            assert!(ticks < 400, "never settled");
        }
        assert!(finite(&s));
    }

    #[test]
    fn linked_nodes_sit_closer_than_unlinked_ones() {
        let links = vec![(0, 1), (2, 3), (4, 5), (6, 7)];
        let mut s = Sim::new(8, links.clone(), 1);
        s.settle();
        let linked: f64 = links.iter().map(|&(i, j)| dist(&s, i, j)).sum::<f64>() / 4.0;
        let unlinked = [(0, 2), (1, 4), (3, 6), (5, 7)];
        let apart: f64 = unlinked.iter().map(|&(i, j)| dist(&s, i, j)).sum::<f64>() / 4.0;
        assert!(linked < apart, "{linked} vs {apart}");
    }

    #[test]
    fn a_pinned_node_stays_put_and_drags_hold_alpha() {
        let mut s = Sim::new(4, vec![(0, 1)], 0);
        s.settle();
        s.hold_warm(true);
        s.drag_to(0, 300.0, -40.0);
        for _ in 0..50 {
            s.tick();
        }
        assert_eq!((s.nodes[0].x, s.nodes[0].y), (300.0, -40.0));
        assert!(!s.settled());
        s.release(0);
        s.hold_warm(false);
        s.settle();
        assert!(s.settled());
        assert!(!s.nodes[0].pinned);
        // Out of range is a no-op, not a panic.
        s.drag_to(99, 0.0, 0.0);
        s.release(99);
    }

    #[test]
    fn the_camera_fits_round_trips_and_zooms_about_the_cursor() {
        let mut s = Sim::new(30, vec![], 2);
        s.settle();
        let cam = Cam::fit(&s, 800.0, 600.0, 40.0);
        for p in &s.nodes {
            let (sx, sy) = cam.to_screen(p.x, p.y, 800.0, 600.0);
            assert!(
                (39.0..=761.0).contains(&sx) && (39.0..=561.0).contains(&sy),
                "{sx},{sy}"
            );
            let (x, y) = cam.to_layout(sx, sy, 800.0, 600.0);
            assert!((x - p.x).abs() < 1e-9 && (y - p.y).abs() < 1e-9);
        }
        let z = cam.zoom_at(1.5, 100.0, 50.0, 800.0, 600.0);
        let (a, b) = (
            cam.to_layout(100.0, 50.0, 800.0, 600.0),
            z.to_layout(100.0, 50.0, 800.0, 600.0),
        );
        assert!((a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9);
        assert_eq!(cam.zoom_at(1e9, 0.0, 0.0, 1.0, 1.0).k, ZOOM_MAX);
        // One node, or a stage smaller than the padding: still a finite, clamped zoom.
        let one = Cam::fit(&Sim::new(1, vec![], 0), 800.0, 600.0, 40.0);
        assert_eq!(one.k, ZOOM_MAX);
        assert!(Cam::fit(&s, 10.0, 10.0, 40.0).k >= ZOOM_MIN);
        assert_eq!(cam.lerp(z, 0.0), cam);
        assert_eq!(cam.lerp(z, 1.0), z);
    }
}
