# 0006: The browser host, the project's DOM, and depth

2026-10-09. Owner approved.

**Context.** A furniture film needed the brand's own React words in
the same frame as a path-traced product, with the product hiding them and chrome reflecting them.
Measured on an RTX 5070 Ti with that template:

- Node's Dawn compiles the path tracer's pipeline in about 185 s on every run (FXC; no cache
  across processes; Dawn would not take DXC). Chrome compiles the same WGSL in 5.9 s, and in 16 ms
  from its disk cache.
- A frame took 1.3–2.0 s in Node (a Remotion still per frame for the words) and 0.53–0.68 s on a
  page with the words as live DOM drawn by HTML-in-Canvas. The 722-frame master took 456 s.
- Hand-drawn Canvas2D words fell far short of the brand's own React components, and redrawing
  them reinvents a design system that exists.

**Decision.** Three additions; the protocol's shape (`render(t)` returns layers) is unchanged.

1. **A browser host beside the Node host.** (Amended 2026-10-09: the project declares its host in
   `shaderera.json` `"host"`, which every tool and job opens; `--host` overrides it per run and
   replaces `--browser`.) The browser host opens the project's runner page in a
   headless Chrome of the user's own install, drives it over the DevTools protocol, and gives
   every command the same `Child` the Node host gives. Chrome's pipeline cache lives in
   `<root>/.shaderera/chrome`. The Node host stays: for machines without Chrome, CI, and sources
   with no DOM.
2. **The project's DOM.** `manifest.dom` names a module (`MountDom`) that lays out any DOM (React,
   any framework, plain HTML and CSS) and sets it to a time. The runner page draws it with
   HTML-in-Canvas (`drawElementImage`, Chrome behind `--enable-features=CanvasDrawElement`) and
   hands it to `render` as `options.dom`, which the source returns as a layer or uses as a
   texture. Canvases inside the DOM are drawn by hand where they are, because the snapshot does
   not carry them there. A DOM is browser-host only; in Node a source makes its own words.
3. **Depth.** A layer's `depth` is no longer experimental: the host depth-tests layers that carry
   it (`soft` fades over a distance), so a layer from one renderer can stand inside another's
   scene. Layers without depth composite `over` as before.

**Not decided here.** What a template knows (where a panel hangs, what counts as the product) stays
in the template. HTML-in-Canvas is behind a flag; if Chrome changes it, a DOM falls back to a
captured still (as the Node words do today).
