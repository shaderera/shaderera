// A virtual clock for a page, injected before any of its scripts by tools/capture-web.ts. The page
// is frozen from its first script (or, with CFG.free for --settle loaded, at the load event) and
// moves only when the capture advances it, so frame k is the state at k / fps however slow the
// machine is.
//
// Ported from reanimate's skills/reanimate/scripts/inpage/clock.js at 3f7a55a
// (https://github.com/NiazMorshed2007/reanimate), under its MIT licence:
//
//   MIT License
//
//   Copyright (c) 2026 Niaz Morshed
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
//
// What Shaderera changed (docs/research/reference-motion-capture.md has the experiments):
// - The freeze and the Date offset are on whole milliseconds, so Date.now's 1 ms steps fall the
//   same way on every run (GSAP reads them).
// - An animation first seen while frozen starts at 0, not at its real currentTime, and a sync runs
//   after each timer and each animation frame's callbacks, and again once the promise
//   continuations and MessageChannel tasks they queued have run (motion's WAAPI handoff, React's
//   scheduler), so an animation is caught on the virtual time it started. The capture dispatches
//   input over CDP between advances and then calls afterInput(), which lets the browser deliver it
//   and syncs, so an animation the input started is caught at the input's time too.
// - rAF tick n falls at the freeze + n * 1000 / rafHz, counted by index from it, and a tick due at
//   the target runs: added-up steps drifted past a frame's time, and JS trailed CSS by a tick.
// - Frozen from the start, or (CFG.free) run on real time until the load event and frozen there,
//   on a whole millisecond. Either way timers and frames stay in the clock's own queue; before the
//   freeze a driver advances it to the real time since the first script. advanceTo takes time
//   from the freeze, rAF ticks are counted from it, and a page that schedules without end is
//   refused, not cut short. The global is __shadereraClock.
// - The page's time starts at constants, never at the real time of the injection: at the freeze,
//   performance.now, rAF timestamps, Event.timeStamp and document.timeline read CFG.timeOrigin
//   (ms), and Date reads CFG.epoch (ms since 1970). A page that reads absolute time gets the same
//   values on every run. Frozen at the load event, they read those plus the time the load took.
//
// What it holds: Math.random (seeded, mulberry32), performance.now, Date, setTimeout and
// setInterval (with the 4 ms clamp on nested timers), requestIdleCallback, requestAnimationFrame,
// Event.timeStamp, document.timeline.currentTime, every CSS and Web Animations API animation on the
// document timeline, and <video>. What it does not: workers, iframes, scroll and view timelines
// (they follow the scroll, which only the capture's input moves), AudioContext,
// requestVideoFrameCallback, Temporal, crypto.getRandomValues, GIF and APNG frames.
;(function install(CFG) {
  const w = self
  if (w.__shadereraClock) return
  const VERSION = '3'

  let seed = CFG.seed >>> 0
  Math.random = function random() {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const N = {
    raf: w.requestAnimationFrame.bind(w),
    caf: w.cancelAnimationFrame.bind(w),
    perfNow: performance.now.bind(performance),
    Date: Date,
    setTimeout: w.setTimeout.bind(w),
    addEventListener: w.addEventListener.bind(w),
  }
  const tsDesc = Object.getOwnPropertyDescriptor(Event.prototype, 'timeStamp')
  const tlDesc =
    w.AnimationTimeline &&
    Object.getOwnPropertyDescriptor(AnimationTimeline.prototype, 'currentTime')

  // Fix 1: whole milliseconds, and the origins are constants.
  const t0 = Math.round(Number(CFG.timeOrigin) || 0)
  const st = {
    now: t0,
    // The freeze: where advanceTo, rAF ticks and startOf count from.
    base: t0,
    free: Boolean(CFG.free),
    // Bumped at the freeze, so an advance the driver has under way stops where it is.
    gen: 0,
    dateOffset: Math.round(Number(CFG.epoch) || 0) - t0,
    nextId: 1,
    seq: 0,
    nesting: 0,
    timers: new Map(),
    rafs: new Map(),
    tick: 1000 / CFG.rafHz,
    tickN: 1,
    anims: new Map(),
    started: new WeakMap(),
    // Each animation in the order first seen, until the capture takes them (drain()).
    fresh: [],
    frames: 0,
    keeper: 0,
  }
  // Fix 3: tick n is counted from the freeze, never added up.
  const nextTick = () => st.base + st.tickN * st.tick

  const call = (cb, args) => {
    try {
      // A string callback is the page's own code, run in global scope as setTimeout runs it.
      if (typeof cb === 'string') w.eval(cb)
      else if (typeof cb === 'function') cb.apply(w, args)
    } catch (e) {
      // Reported as the browser reports an uncaught error, without stopping the clock.
      N.setTimeout(() => {
        throw e
      })
    }
  }

  // ---------- timers ----------
  const addTimer = (cb, delay, args, interval) => {
    const id = st.nextId++
    const nesting = st.nesting + 1
    let d = Math.max(0, Number(delay) || 0)
    if (nesting > 5 || interval) d = Math.max(d, nesting > 5 ? 4 : 1)
    st.timers.set(id, { id, cb, args, delay: d, interval, due: st.now + d, seq: st.seq++, nesting })
    return id
  }
  const fire = (t) => {
    if (t.interval) {
      t.due += t.delay
      t.seq = st.seq++
    } else st.timers.delete(t.id)
    const prev = st.nesting
    st.nesting = t.nesting
    call(t.cb, t.args)
    st.nesting = prev
    // Fix 2: an animation the callback started is caught now.
    syncAnims()
  }
  w.setTimeout = function setTimeout(cb, delay, ...args) {
    return addTimer(cb, delay, args, false)
  }
  w.setInterval = function setInterval(cb, delay, ...args) {
    return addTimer(cb, delay, args, true)
  }
  w.clearTimeout = function clearTimeout(id) {
    st.timers.delete(id)
  }
  w.clearInterval = function clearInterval(id) {
    st.timers.delete(id)
  }
  w.requestIdleCallback = function requestIdleCallback(cb, opts) {
    const timeout = Math.min(50, opts?.timeout || 1)
    return addTimer(() => cb({ didTimeout: false, timeRemaining: () => 10 }), timeout, [], false)
  }
  w.cancelIdleCallback = function cancelIdleCallback(id) {
    st.timers.delete(id)
  }

  // ---------- animation frames ----------
  w.requestAnimationFrame = function requestAnimationFrame(cb) {
    const id = st.nextId++
    st.rafs.set(id, cb)
    return id
  }
  w.cancelAnimationFrame = function cancelAnimationFrame(id) {
    st.rafs.delete(id)
  }
  const runFrame = (ts) => {
    st.frames++
    syncAnims()
    syncVideos()
    const due = [...st.rafs.values()]
    st.rafs.clear() // callbacks registered while these run belong to the next frame
    for (const cb of due) call(cb, [ts])
    // Fix 2: an animation a callback started is caught on this tick.
    syncAnims()
  }

  // ---------- CSS animations, transitions and WAAPI ----------
  // Each running animation on the document timeline is paused when first seen and then seeked to
  // base + (virtual now - first seen) * playbackRate. Finite ones are finish()ed at their end, so
  // `finished` promises and finish events still fire (motion waits on them).
  function syncAnims() {
    let list
    try {
      list = document.getAnimations()
    } catch {
      return
    }
    for (const a of list) {
      if (a.timeline && a.timeline !== document.timeline) continue // scroll and view timelines
      let rec = st.anims.get(a)
      if (!rec || a.playState === 'running') {
        if (!rec && a.playState !== 'running') continue // paused or finished by the page
        // Fix 2: first seen while frozen, it starts at 0.
        rec = { base: rec ? a.currentTime || 0 : 0, v0: st.now }
        if (!st.started.has(a)) {
          st.started.set(a, st.now)
          st.fresh.push(a)
        }
        st.anims.set(a, rec)
        try {
          a.pause()
        } catch {
          continue
        }
      }
      const rate = a.playbackRate || 1
      const t = rec.base + (st.now - rec.v0) * rate
      let end = Number.POSITIVE_INFINITY
      try {
        end = a.effect ? a.effect.getComputedTiming().endTime : end
      } catch {}
      if ((rate > 0 && t >= end) || (rate < 0 && t <= 0)) {
        st.anims.delete(a)
        try {
          a.finish()
        } catch {}
        continue
      }
      try {
        a.currentTime = t
      } catch {}
    }
  }
  // <video> plays on the decoder's real clock: each playing one is paused when first seen and
  // seeked with the virtual clock; busy() holds the frame until the seek has landed.
  const videos = new Map()
  const syncVideos = () => {
    let list
    try {
      list = document.querySelectorAll('video')
    } catch {
      return
    }
    for (const v of list) {
      let rec = videos.get(v)
      if (!rec) {
        if (v.paused) continue
        rec = { base: v.currentTime, v0: st.now }
        videos.set(v, rec)
        try {
          v.pause()
        } catch {}
      }
      let t = rec.base + ((st.now - rec.v0) / 1000) * (v.playbackRate || 1)
      if (v.loop && v.duration > 0) t %= v.duration
      else if (v.duration > 0) t = Math.min(t, v.duration)
      if (Math.abs(v.currentTime - t) > 0.001)
        try {
          v.currentTime = t
        } catch {}
    }
  }

  // Between advances (the page loading, a response arriving), new animations are caught on the
  // browser's own frames, so they start from 0 at the frozen time instead of running.
  const keeper = () => {
    syncAnims()
    st.keeper = N.raf(keeper)
  }
  const startKeeper = () => {
    N.caf(st.keeper)
    keeper()
  }

  // ---------- time sources ----------
  performance.now = function now() {
    return st.now
  }
  function VDate(...a) {
    if (!new.target) return new N.Date(VDate.now()).toString()
    return a.length ? new N.Date(...a) : new N.Date(VDate.now())
  }
  VDate.prototype = N.Date.prototype
  VDate.now = () => Math.round(st.dateOffset + st.now)
  VDate.parse = N.Date.parse
  VDate.UTC = N.Date.UTC
  Object.defineProperty(VDate.prototype, 'constructor', {
    value: VDate,
    writable: true,
    configurable: true,
  })
  w.Date = VDate
  if (tsDesc?.get)
    Object.defineProperty(Event.prototype, 'timeStamp', {
      configurable: true,
      get() {
        return st.now
      },
    })
  if (tlDesc?.get)
    Object.defineProperty(AnimationTimeline.prototype, 'currentTime', {
      configurable: true,
      get() {
        return this === document.timeline ? st.now : tlDesc.get.call(this)
      },
    })

  // ---------- workers ----------
  // A worker answers on its own (real) clock. The capture waits for posted but unanswered
  // messages before each frame, as it waits for the network, so a reply lands on the same virtual
  // frame. A worker that never answers stops counting after 2 s.
  const pending = new Map()
  if (w.Worker) {
    const post = w.Worker.prototype.postMessage
    w.Worker.prototype.postMessage = function postMessage(...args) {
      if (!this.__shadereraSilent) pending.set(this, N.perfNow())
      if (!this.__shadereraListening) {
        this.__shadereraListening = true
        this.addEventListener('message', () => pending.delete(this))
        this.addEventListener('error', () => pending.delete(this))
      }
      return post.apply(this, args)
    }
  }
  const busy = () => {
    let n = 0
    for (const v of videos.keys()) if (v.seeking) n++
    for (const [wk, t] of pending) {
      if (N.perfNow() - t > 2000) {
        wk.__shadereraSilent = true
        pending.delete(wk)
      } else n++
    }
    return n
  }

  // ---------- control ----------
  const mc = new MessageChannel()
  const waiting = []
  mc.port1.onmessage = () => waiting.shift()?.()
  const yieldTask = () =>
    new Promise((r) => {
      waiting.push(r)
      mc.port2.postMessage(0)
    })

  // Runs timers and frames in time order up to `target` (absolute), yielding a task between
  // callbacks so promise chains and MessageChannel schedulers (React) keep up. The freeze stops
  // it where it is.
  const advance = async (target) => {
    const gen = st.gen
    N.caf(st.keeper)
    for (let guard = 0; st.gen === gen; guard++) {
      if (guard === 200000)
        throw new Error(
          `the page scheduled 200000 callbacks before ${target - st.base} ms: it never settles`,
        )
      let next = null
      for (const t of st.timers.values())
        if (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq)) next = t
      const tick = nextTick()
      // Fix 3: a tick due at the target runs; the tolerance absorbs n * (1000 / rafHz) rounding.
      if (Math.min(next ? next.due : Number.POSITIVE_INFINITY, tick) > target + 1e-6) break
      if (next && next.due <= tick) {
        st.now = Math.max(st.now, next.due)
        fire(next)
      } else {
        st.now = tick
        st.tickN++
        runFrame(st.now)
      }
      await yieldTask()
      // Fix 2: and one a promise or a MessageChannel task started after it, before time moves on.
      syncAnims()
    }
    if (st.gen === gen) st.now = target
    syncAnims()
    syncVideos()
    startKeeper()
  }

  /** Runs timers and frames up to `ms` after the freeze. Returns the time after it, in ms. */
  const advanceTo = async (ms) => {
    if (st.free) throw new Error('the clock runs on real time until the load event')
    const target = st.base + ms
    if (!(target >= st.now))
      throw new Error(`the clock is at ${st.now - st.base} ms, not before ${ms}`)
    await advance(target)
    return st.now - st.base
  }

  // With CFG.free, before the freeze: the clock follows real time from the first script, on
  // whole milliseconds, until the load event freezes it.
  const realStart = N.perfNow()
  let freezing = null
  const freeze = () => {
    if (!st.free) return
    st.free = false
    st.gen++
    // On a whole millisecond (fix 1), and ticks are counted again from here (fix 3).
    st.now = Math.ceil(st.now - 1e-6)
    st.base = st.now
    st.tickN = 1
    syncAnims()
  }
  if (st.free) {
    freezing = (async () => {
      while (st.free) {
        const target = t0 + Math.floor(N.perfNow() - realStart)
        if (target > st.now) await advance(target)
        if (st.free) await new Promise((r) => N.setTimeout(r, 1))
      }
    })()
    // The first load listener: the page's own run frozen, as they do when frozen from the start.
    N.addEventListener('load', freeze, { once: true, capture: true })
  }

  // After the capture dispatched input: the browser delivers it, a scroll lands (the position is
  // the same on two frames running), and animations it started are caught at this time.
  const nativeFrame = () => new Promise((r) => N.raf(() => r()))
  const afterInput = async () => {
    let last = ''
    for (let calm = 0, i = 0; calm < 2 && i < 120; i++) {
      await nativeFrame()
      const at = `${w.scrollX} ${w.scrollY}`
      calm = at === last ? calm + 1 : 0
      last = at
    }
    await yieldTask()
    syncAnims()
    return st.now - st.base
  }

  syncAnims()
  keeper()
  w.__shadereraClock = {
    version: VERSION,
    seed: CFG.seed,
    rafHz: CFG.rafHz,
    timeOrigin: t0,
    epoch: st.dateOffset + t0,
    advanceTo,
    afterInput,
    busy,
    /** Once frozen: how long after the first script the freeze came, in ms (0 unless CFG.free). */
    frozen: async () => {
      await freezing
      return st.base - t0
    },
    /** When an animation was first seen, in ms after the freeze, or null if it never was. */
    startOf: (a) => (st.started.has(a) ? st.started.get(a) - st.base : null),
    /** The animations first seen since the last call, in the order they were seen. */
    drain: () => st.fresh.splice(0),
    sync: () => {
      syncAnims()
      return st.now - st.base
    },
    state: () => ({
      now: st.now - st.base,
      timers: st.timers.size,
      rafs: st.rafs.size,
      frames: st.frames,
      animations: st.anims.size,
    }),
  }
})
