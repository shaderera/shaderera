# Fast-compiling WGSL

For a film whose WGSL takes seconds to compile in the browser, and for keeping a new film's
shaders from getting there.

## Why it is slow

- On Windows, Chrome compiles WGSL to HLSL and then to DXIL with DXC (Chrome 121 and later, on
  GPUs with Shader Model 6). DXIL has no function calls: every call is inlined.
- So a large function called from several places is compiled once per call site, and calls nested
  inside each other multiply. A function called 4 times, from a function called twice, from one
  called twice, is compiled 4 × 2 × 2 = 16 times. In one film, 16 copies of a 16-way `switch`
  over shapes made one compute pipeline take 8 to 10 s to compile cold.
- Browsers cache compiled pipelines per site, so a returning viewer mostly does not pay it again.
  A first visit does, and so does every edit to the shader while developing.

## How to notice it

A long wait before the first frame in the browser, with no network request still loading. The
time goes into `createComputePipeline` or `createRenderPipeline` (or their `Async` forms): measure
around the call, or look in Chrome DevTools, Performance.

## The rule

Call each heavy function from one site. Where you need several results from it, call it in a loop
and keep the results, and take the loop's count from a uniform, so the compiler cannot unroll the
loop back into several copies:

```wgsl
struct Params { samples: u32 }  // set to 4 from the CPU
@group(0) @binding(0) var<uniform> params: Params;

var acc = vec4f(0.0);
for (var i = 0u; i < params.samples; i++) {
  acc += evaluate(offset(i));  // one call site, however many samples
}
```

The film above went from 8 to 10 s to about 2 s this way, with identical output. A loop with a
constant count (`for (var i = 0u; i < 4u; i++)`) may be unrolled, which brings the copies back.

## Check

Open the film in Chrome on Windows with an empty cache (a new profile, or after clearing site
data) and time the wait before the first frame, before and after the change. Compare stills from
before and after (`npx shaderera still <t>... --sheet`): the output should not change.
