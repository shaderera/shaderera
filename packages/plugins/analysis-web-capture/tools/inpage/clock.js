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
// - Every frame and dedicated worker has a clock of its own, each driven by the one that made it:
//   the top frame's by the capture, a frame's by its parent, a worker's by the frame or worker
//   that started it. They step together, on one time. Before each step the parent asks its
//   children for their next timer or tick, the earliest of all is the step, and after it the
//   parent steps each child to that time and waits until no message between them is in flight. So
//   a reply lands at the time its question was sent, and a worker's timers, animation frames and
//   OffscreenCanvas drawing run on the same time as the page. The messages between a parent and a
//   child are FIFO: the child's answer comes after every message it sent before it.
// - <video> is paused for Chrome and seeked with the clock, while for the page it plays (paused is
//   false, as it would be), so it shows the frame at its own time; an autoplay video starts when
//   it is first seen in the document, however long it takes to load.
//
// What it holds: Math.random (seeded, mulberry32), performance.now, Date, setTimeout and
// setInterval (with the 4 ms clamp on nested timers), requestIdleCallback, requestAnimationFrame,
// Event.timeStamp, document.timeline.currentTime, every CSS and Web Animations API animation on the
// document timeline, <video>, and the same in frames and dedicated workers. What it does not:
// shared and service workers, messages on a MessagePort or BroadcastChannel between two of them,
// messages between frames that are not parent and child, a video that cannot be seeked, <audio>
// (its currentTime and events run on real time), scroll and view timelines (they follow the
// scroll, which the input or the page's script moves), AudioContext, requestVideoFrameCallback,
// Temporal, crypto.getRandomValues, GIF and APNG frames.
;(function install(CFG) {
  const w = self
  if (w.__shadereraClock) return
  const VERSION = '4'
  // The key that marks the clocks' own messages to each other; the page never sees them.
  const MARK = '__shadereraClockMessage'

  // The document is read each time, never kept: a frame's window can outlive the empty document
  // it started with and go on to hold its own.
  const isWorker = typeof document === 'undefined'
  const doc = () => (isWorker ? null : w.document)
  const isFrame = !isWorker && w !== w.top
  const isChild = isFrame || isWorker
  const waitMs = Number(CFG.waitMs) || 15000
  // How long a child may take to answer: longer than it may wait on its own children.
  const ASK_MS = waitMs * 4

  let seed = CFG.seed >>> 0
  Math.random = function random() {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const N = {
    raf: w.requestAnimationFrame ? w.requestAnimationFrame.bind(w) : null,
    caf: w.cancelAnimationFrame ? w.cancelAnimationFrame.bind(w) : () => {},
    perfNow: performance.now.bind(performance),
    Date: Date,
    setTimeout: w.setTimeout.bind(w),
    clearTimeout: w.clearTimeout.bind(w),
    addEventListener: w.addEventListener.bind(w),
    postMessage: w.postMessage.bind(w),
  }
  const tsDesc = Object.getOwnPropertyDescriptor(Event.prototype, 'timeStamp')
  const tlDesc =
    w.AnimationTimeline &&
    Object.getOwnPropertyDescriptor(AnimationTimeline.prototype, 'currentTime')

  // Fix 1: whole milliseconds, and the origins are constants.
  const t0 = Math.round(Number(CFG.timeOrigin) || 0)
  // A child starts at its parent's time: from the capture (a worker, a frame in a process of its
  // own), or read from a parent of the same origin. Its parent's init corrects it either way.
  let start = CFG.start
  if (!start && isFrame)
    try {
      start = w.parent.__shadereraClock?.time()
    } catch {}
  const st = {
    now: start ? start.now : t0,
    // The freeze: where advanceTo, rAF ticks and startOf count from.
    base: start ? start.base : t0,
    free: Boolean(CFG.free) && !isChild,
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
    // What the clock could not hold, for the capture's limits, until it takes them.
    limits: [],
  }
  // Fix 3: tick n is counted from the freeze, never added up.
  const nextTick = () => st.base + st.tickN * st.tick
  // The first tick after `now`, counted from the freeze: a child joins on its parent's ticks.
  const alignTicks = () => {
    st.tickN = Math.max(1, Math.floor((st.now - st.base) / st.tick + 1e-9) + 1)
  }
  if (start) alignTicks()
  // A child has started once its parent's init has set its time.
  let started = !isChild
  // A limit with the time it began, in seconds after the freeze.
  const limit = (where, reason) =>
    st.limits.push({ where: String(where), reason, from: (st.now - st.base) / 1000 })
  // The same limit once, at the first time it is met.
  const met = new Set()
  const limitOnce = (where, reason) => {
    const key = `${where}\n${reason}`
    if (met.has(key)) return
    met.add(key)
    limit(where, reason)
  }
  const PORT_REASON =
    'a MessagePort was sent to it: messages on that port are not waited for, so a reply on it can land on a later frame'

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
    syncAll()
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
  // A worker has them too, for an OffscreenCanvas.
  if (N.raf) {
    w.requestAnimationFrame = function requestAnimationFrame(cb) {
      const id = st.nextId++
      st.rafs.set(id, cb)
      return id
    }
    w.cancelAnimationFrame = function cancelAnimationFrame(id) {
      st.rafs.delete(id)
    }
  }
  const runFrame = (ts) => {
    st.frames++
    syncAll()
    const due = [...st.rafs.values()]
    st.rafs.clear() // callbacks registered while these run belong to the next frame
    for (const cb of due) call(cb, [ts])
    // Fix 2: an animation a callback started is caught on this tick.
    syncAll()
  }

  // ---------- CSS animations, transitions and WAAPI ----------
  // Each running animation on the document timeline is paused when first seen and then seeked to
  // base + (virtual now - first seen) * playbackRate. Finite ones are finish()ed at their end, so
  // `finished` promises and finish events still fire (motion waits on them).
  function syncAnims() {
    if (isWorker) return
    let list
    try {
      list = doc().getAnimations()
    } catch {
      return
    }
    for (const a of list) {
      if (a.timeline && a.timeline !== doc().timeline) continue // scroll and view timelines
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

  // ---------- <video> ----------
  // A video plays on the decoder's real clock. Held, it is paused for Chrome, which then shows the
  // frame it is seeked to, and it is seeked to base + (virtual now - v0) * playbackRate. (Held at
  // playbackRate 0 instead, so that it stayed playing, Chrome showed a frame a seek or two behind
  // under CPU throttling.) For the page it plays as asked: paused reads what the page asked for,
  // play() resolves and fires play and playing, pause() fires pause, the end fires pause and
  // ended, each in a task of its own; the pauses the clock causes are not passed on. An autoplay
  // video is held from when the clock first sees it in the document, as if it played at once:
  // when Chrome would start it depends on how fast it loads. busy() holds a frame until a seek has
  // landed and Chrome has presented its frame.
  const videos = new Map()
  const media = w.HTMLMediaElement?.prototype
  const desc = (name) => media && Object.getOwnPropertyDescriptor(media, name)
  const timeDesc = desc('currentTime')
  const rateDesc = desc('playbackRate')
  const pausedDesc = desc('paused')
  const nativePlay = media?.play
  const nativePause = media?.pause
  const frameCallback = w.HTMLVideoElement?.prototype.requestVideoFrameCallback
  const isVideo = (v) => !!w.HTMLVideoElement && v instanceof HTMLVideoElement
  const nativePaused = (v) => pausedDesc.get.call(v)
  // The events a playing video sends, each in a task of its own, as the browser sends them. An
  // advance yields a task after each callback, so they come before time moves on.
  const sent = new MessageChannel()
  const toSend = []
  sent.port1.onmessage = () => {
    const [v, type] = toSend.shift()
    v.dispatchEvent(new Event(type))
  }
  const send = (v, ...types) => {
    for (const type of types) {
      toSend.push([v, type])
      sent.port2.postMessage(0)
    }
  }
  const stop = (v, rec) => {
    if (nativePaused(v)) return
    rec.quiet++
    nativePause.call(v)
  }
  const target = (v, rec) => {
    const rate = rateDesc.get.call(v)
    let t = rec.running ? rec.base + ((st.now - rec.v0) / 1000) * rate : rec.base
    if (v.loop && v.duration > 0 && Number.isFinite(v.duration)) t %= v.duration
    else if (v.duration > 0) t = Math.min(t, v.duration)
    return Math.max(0, t)
  }
  const hold = (v, running) => {
    let rec = videos.get(v)
    if (!rec) {
      rec = {
        base: timeDesc.get.call(v),
        v0: st.now,
        running: false,
        quiet: 0,
        shown: true,
        seekedAt: 0,
        // The time the clock last sought, how many times in a row, and whether it gave up.
        tried: null,
        tries: 0,
        stuck: false,
      }
      videos.set(v, rec)
      // Paused, Chrome does not autoplay it either.
      stop(v, rec)
    }
    if (running && !rec.running) {
      rec.base = target(v, rec)
      rec.v0 = st.now
      rec.running = true
      send(v, 'play', 'playing')
    }
    return rec
  }
  const syncVideo = (v, rec, seek) => {
    // Chrome started it after all (an autoplay before the clock saw it): it stays held.
    stop(v, rec)
    if (rec.running && !v.loop && v.duration > 0 && target(v, rec) >= v.duration) {
      rec.base = target(v, rec)
      rec.running = false
      send(v, 'pause', 'ended')
    }
    // Seeked only before a frame is read (busy()), one seek at a time, each once the last one's
    // frame is on screen: a paused video seeked again before that can go on showing an earlier
    // frame after the last seek has landed. Chrome keeps media time in whole microseconds.
    const t = target(v, rec)
    // Before its metadata a seek only sets where it will start, and presents nothing.
    if (!seek || rec.stuck || v.readyState < 1 || v.seeking) return
    if (Math.abs(timeDesc.get.call(v) - t) <= 1e-6) return
    // A time the decoder cannot reach (a server that does not serve ranges gives a video it can
    // seek only to 0), or seeks to it that keep landing elsewhere: it is not waited on again. A
    // seek that landed elsewhere may present nothing, so this comes before waiting for it.
    if (!seekable(v, t)) return giveUp(v, rec)
    if (!presented(v, rec)) return
    rec.tries = rec.tried === t ? rec.tries + 1 : 1
    rec.tried = t
    if (rec.tries > 3) return giveUp(v, rec)
    seekTo(v, rec, t)
  }
  const giveUp = (v, rec) => {
    rec.stuck = true
    limit(
      videoName(v),
      'a video that cannot be seeked to its time (its server may not serve ranges): it shows the frame it has',
    )
  }
  const videoName = (v) => v.currentSrc || v.src || 'a video'
  // Whether the decoder can seek to t, once it has the video's metadata.
  const seekable = (v, t) => {
    const r = v.seekable
    for (let i = 0; i < r.length; i++)
      if (r.start(i) - 1e-6 <= t && t <= r.end(i) + 1e-6) return true
    return false
  }
  // A seek, the clock's or the page's, and when Chrome has presented its frame, which it does
  // after every seek.
  const seekTo = (v, rec, t) => {
    try {
      timeDesc.set.call(v, t)
    } catch {
      return
    }
    // Before its metadata, or moved by Chrome to a time it can seek to (which may be the frame it
    // shows), it may present nothing.
    if (!frameCallback || v.readyState < 1 || Math.abs(timeDesc.get.call(v) - t) > 1e-6) return
    rec.shown = false
    rec.seekedAt = N.perfNow()
    frameCallback.call(v, () => {
      rec.shown = true
    })
  }
  // Whether the last seek's frame is on screen. A video with no box or out of the viewport
  // presents nothing, and one that has not in 1 s is taken as shown, so a frame is never held. That
  // is no limit: Chrome does not call back after every seek (one that lands on the frame it shows,
  // 0 to 1/30 s in a 30 fps clip, is one), and the frames read then are right in the video test.
  const presented = (v, rec) => {
    if (rec.shown || N.perfNow() - rec.seekedAt > 1000) return true
    const r = v.getBoundingClientRect()
    const seen = r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0
    return !(seen && r.left < w.innerWidth && r.top < w.innerHeight)
  }
  const syncVideos = (seek = false) => {
    if (isWorker || !media) return
    let list
    try {
      list = new Set([...doc().querySelectorAll('video'), ...videos.keys()])
    } catch {
      return
    }
    for (const v of list) {
      let rec = videos.get(v)
      if (!rec) {
        if (nativePaused(v) && !v.autoplay) continue
        rec = hold(v, true)
      }
      syncVideo(v, rec, seek)
    }
  }
  if (media) {
    media.play = function play(...args) {
      // Not a video, or one whose source Chrome cannot play: Chrome's own play(), which rejects.
      if (!isVideo(this) || this.error?.code === 4) return nativePlay.apply(this, args)
      // A video that would load only once played loads now.
      if (this.readyState === 0 && this.preload === 'none') this.load()
      hold(this, true)
      return Promise.resolve()
    }
    media.pause = function pause(...args) {
      const rec = videos.get(this)
      if (!rec) return nativePause.apply(this, args)
      if (!rec.running) return
      rec.base = target(this, rec)
      rec.running = false
      send(this, 'pause')
    }
    Object.defineProperty(media, 'paused', {
      configurable: true,
      enumerable: pausedDesc.enumerable,
      get() {
        const rec = videos.get(this)
        return rec ? !rec.running : pausedDesc.get.call(this)
      },
    })
    // The page changes the rate or seeks: playing goes on from there.
    Object.defineProperty(media, 'playbackRate', {
      configurable: true,
      enumerable: rateDesc.enumerable,
      get() {
        return rateDesc.get.call(this)
      },
      set(r) {
        const rec = videos.get(this)
        if (rec) {
          rec.base = target(this, rec)
          rec.v0 = st.now
        }
        rateDesc.set.call(this, r)
      },
    })
    Object.defineProperty(media, 'currentTime', {
      configurable: true,
      enumerable: timeDesc.enumerable,
      // Held, it reads its time on the clock, which the decoder is seeked to before a frame is
      // read.
      get() {
        const rec = videos.get(this)
        return rec ? target(this, rec) : timeDesc.get.call(this)
      },
      set(t) {
        const rec = videos.get(this)
        if (!rec) return timeDesc.set.call(this, t)
        seekTo(this, rec, t)
        rec.base = timeDesc.get.call(this)
        rec.v0 = st.now
      },
    })
    // The pause the clock caused is its own: the page does not see it.
    N.addEventListener(
      'pause',
      (e) => {
        const rec = videos.get(e.target)
        if (rec && rec.quiet > 0 && e.isTrusted) {
          rec.quiet--
          e.stopImmediatePropagation()
        }
      },
      true,
    )
  }
  const syncAll = () => {
    syncAnims()
    syncVideos()
  }

  // Between advances (the page loading, a response arriving), new animations are caught on the
  // browser's own frames, so they start from 0 at the frozen time instead of running.
  const keeper = () => {
    syncAll()
    st.keeper = N.raf(keeper)
  }
  const startKeeper = () => {
    if (isWorker) return
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
        return !isWorker && this === doc().timeline ? st.now : tlDesc.get.call(this)
      },
    })

  // ---------- control ----------
  const mc = new MessageChannel()
  const waiting = []
  mc.port1.onmessage = () => waiting.shift()?.()
  const yieldTask = () =>
    new Promise((r) => {
      waiting.push(r)
      mc.port2.postMessage(0)
    })
  const realWait = (ms) => new Promise((r) => N.setTimeout(r, ms))
  const isControl = (data) =>
    data !== null && typeof data === 'object' && Object.hasOwn(data, MARK) && !Array.isArray(data)

  // ---------- children: frames and workers ----------
  // Each child is a frame or a worker this context made, with its own clock. `got` counts the
  // page's messages from it, so the parent knows when none is in flight.
  const children = new Map()
  // Children made but not yet heard from: a worker whose script is loading, a frame navigating.
  const starting = new Map()
  let asked = 0
  const answers = new Map()
  const drop = (key, reason) => {
    const c = children.get(key)
    if (!c) return
    children.delete(key)
    for (const [id, a] of answers)
      if (a.child === c) {
        answers.delete(id)
        a.done(null)
      }
    if (reason) limit(c.where, `${reason}: it runs on real time from then`)
  }
  // One question to a child and its answer, or null once it is gone or after waitMs.
  const ask = (key, msg) => {
    const c = children.get(key)
    if (!c) return Promise.resolve(null)
    if (c.closed?.()) {
      drop(key)
      return Promise.resolve(null)
    }
    const id = ++asked
    return new Promise((done) => {
      const timer = N.setTimeout(() => {
        answers.delete(id)
        drop(key, `${c.kind} stopped answering the clock`)
        done(null)
      }, ASK_MS)
      answers.set(id, {
        child: c,
        done: (v) => {
          N.clearTimeout(timer)
          done(v)
        },
      })
      try {
        c.post({ [MARK]: msg.op, id, ...msg })
      } catch {
        answers.delete(id)
        N.clearTimeout(timer)
        drop(key)
        done(null)
      }
    })
  }
  // A child's message: a clock's own, or the page's (counted).
  const fromChild = (key, data) => {
    const c = children.get(key)
    if (!isControl(data)) {
      if (c) c.got++
      return false
    }
    const op = data[MARK]
    if (op === 'answer') {
      const a = answers.get(data.id)
      if (a) {
        answers.delete(data.id)
        for (const l of data.limits ?? []) st.limits.push(l)
        a.done(data)
      }
    } else if (op === 'bye') {
      for (const l of data.limits ?? []) st.limits.push(l)
      drop(key)
    }
    return true
  }
  const hello = (key, child) => {
    // A frame that navigated says hello again: its old clock is gone.
    if (children.has(key)) drop(key)
    starting.delete(key)
    children.set(key, child)
    child.post({ [MARK]: 'init', now: st.now, base: st.base })
  }
  const startingFor = (key, kind, url) => {
    if (!starting.has(key)) starting.set(key, { kind, where: url, since: N.perfNow() })
  }
  // Waits for the children being made, so each starts at the time it was made.
  const ready = async () => {
    while (starting.size > 0) {
      for (const [key, s] of starting) {
        if (s.gone?.()) starting.delete(key)
        else if (N.perfNow() - s.since > waitMs) {
          starting.delete(key)
          limit(
            s.where,
            `a ${s.kind} the clock did not reach in ${waitMs / 1000} s: it runs on real time`,
          )
        }
      }
      if (starting.size > 0) await realWait(1)
    }
  }

  // Workers: each one made here is a child, heard from on the Worker object, first of all.
  if (w.Worker) {
    const NativeWorker = w.Worker
    const post = NativeWorker.prototype.postMessage
    const terminate = NativeWorker.prototype.terminate
    const urls = new WeakMap()
    const ports = (args) => {
      const list = Array.isArray(args[1]) ? args[1] : args[1]?.transfer
      return Array.isArray(list) && list.some((p) => w.MessagePort && p instanceof MessagePort)
    }
    w.Worker = new Proxy(NativeWorker, {
      construct(target, args, newTarget) {
        const wk = Reflect.construct(target, args, newTarget)
        let url = String(args[0])
        try {
          url = new URL(url, w.location.href).href
        } catch {}
        const child = {
          kind: 'worker',
          where: url,
          got: 0,
          post: (m) => post.call(wk, m),
        }
        urls.set(wk, url)
        startingFor(wk, 'worker', url)
        wk.addEventListener(
          'message',
          (e) => {
            if (isControl(e.data) && e.data[MARK] === 'hello') {
              e.stopImmediatePropagation()
              hello(wk, child)
            } else if (fromChild(wk, e.data)) e.stopImmediatePropagation()
            else if (e.ports.length > 0) limitOnce(url, PORT_REASON)
          },
          true,
        )
        wk.addEventListener('error', () => {
          if (starting.has(wk)) {
            starting.delete(wk)
            limit(url, 'a worker whose script did not load')
          }
        })
        return wk
      },
    })
    // A port sent to a worker, here; one sent to or from a frame, or from a worker, is seen where
    // it arrives.
    NativeWorker.prototype.postMessage = function postMessage(...args) {
      if (ports(args)) limitOnce(urls.get(this) ?? 'a worker', PORT_REASON)
      return post.apply(this, args)
    }
    NativeWorker.prototype.terminate = function terminate_() {
      starting.delete(this)
      drop(this)
      return terminate.call(this)
    }
  }
  if (w.SharedWorker) {
    const NativeShared = w.SharedWorker
    w.SharedWorker = new Proxy(NativeShared, {
      construct(target, args, newTarget) {
        let url = String(args[0])
        try {
          url = new URL(url, w.location.href).href
        } catch {}
        limit(url, 'a shared worker: its clock is not held, so it runs on real time')
        return Reflect.construct(target, args, newTarget)
      },
    })
  }
  if (w.BroadcastChannel) {
    const NativeChannel = w.BroadcastChannel
    w.BroadcastChannel = new Proxy(NativeChannel, {
      construct(target, args, newTarget) {
        limit(
          `BroadcastChannel ${String(args[0])}`,
          'its messages between frames and workers are not waited for, so one can land on a later frame',
        )
        return Reflect.construct(target, args, newTarget)
      },
    })
  }

  // Frames: a child frame's clock says hello to its parent; a frame being made or navigating holds
  // the parent until it has, or has loaded without a clock.
  if (!isWorker) {
    const frameOf = (source) => {
      for (const el of doc().querySelectorAll('iframe, frame'))
        if (el.contentWindow === source) return el
      return null
    }
    N.addEventListener(
      'message',
      (e) => {
        const src = e.source
        if (!src || src === w) return
        if (isControl(e.data) && e.data[MARK] === 'hello') {
          // Only from a frame of this document; a grandchild says hello to its own parent.
          if (src.parent !== w) return
          e.stopImmediatePropagation()
          const el = frameOf(src)
          if (el) starting.delete(el)
          // A frame's first script runs before its URL is set: its src names it.
          let url = el?.src || e.origin
          try {
            url = src.location.href
          } catch {}
          hello(src, {
            kind: 'iframe',
            where: url,
            got: 0,
            post: (m) => src.postMessage(m, '*'),
            closed: () => src.closed,
          })
          return
        }
        const c = children.get(src)
        if (c) {
          if (fromChild(src, e.data)) e.stopImmediatePropagation()
          else if (e.ports.length > 0) limitOnce(c.where, PORT_REASON)
          return
        }
        // From a frame that is neither this one's parent nor its child (a sibling, a grandchild, a
        // popup): no clock counts it. A frame of this one with no clock is named as unclocked.
        let theirs = null
        try {
          theirs = src.parent
        } catch {}
        if (theirs === w || src === w.parent) return
        let from = e.origin
        try {
          from = src.location.href
        } catch {}
        limitOnce(
          from,
          'it messaged a frame that is not its parent or child: those messages are not waited for, so one can land on a later frame',
        )
      },
      true,
    )
    const watch = (el) => {
      const url = el.src || (el.hasAttribute('srcdoc') ? 'about:srcdoc' : 'about:blank')
      // A frame of the same origin that has its clock, or has loaded, is no longer starting.
      startingFor(el, 'iframe', url)
      const s = starting.get(el)
      // One of this origin that has loaded with no clock (about:blank) runs nothing; one with a
      // clock is waited for, as its hello is on the way. Across origins, its hello or load.
      s.gone = () => {
        if (!el.isConnected) return true
        try {
          const win = el.contentWindow
          const d = el.contentDocument
          const navigating = url !== 'about:blank' && win.location.href === 'about:blank'
          return !!d && d.readyState === 'complete' && !navigating && !win.__shadereraClock
        } catch {
          return false
        }
      }
      el.addEventListener('load', () => starting.delete(el), { once: true, capture: true })
    }
    const scan = (node) => {
      if (node.nodeType !== 1) return
      if (node.localName === 'iframe' || node.localName === 'frame') watch(node)
      for (const el of node.querySelectorAll?.('iframe, frame') ?? []) watch(el)
    }
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') watch(r.target)
        else for (const n of r.addedNodes) scan(n)
      }
    })
    // The document this window holds now, and again once its own has replaced the empty one.
    let observed = null
    const observe = () => {
      const d = doc()
      if (d === observed) return
      // The new document's frames, and the keeper again: the old document's animation frames went
      // with it.
      if (observed) {
        scan(d.documentElement ?? d)
        startKeeper()
      }
      observed = d
      observer.observe(d, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcdoc'],
      })
    }
    observe()
    N.addEventListener('readystatechange', observe, true)
    N.addEventListener('DOMContentLoaded', observe, true)
  }

  // The earliest next timer or tick here and in every child, absolute.
  const ownNext = () => {
    let next = null
    for (const t of st.timers.values())
      if (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq)) next = t
    return { next, at: Math.min(next ? next.due : Number.POSITIVE_INFINITY, nextTick()) }
  }
  const nextDue = async () => {
    let at = ownNext().at
    if (children.size > 0) {
      const answers_ = await Promise.all([...children.keys()].map((k) => ask(k, { op: 'next' })))
      for (const a of answers_) if (a && typeof a.at === 'number') at = Math.min(at, a.at)
    }
    return at
  }
  // Every child stepped to `t`, again until a round passes with no page message either way.
  const settleChildren = async (t) => {
    for (let round = 0; children.size > 0; round++) {
      if (round === 10000)
        throw new Error(
          `the page's frames and workers kept messaging each other at ${t - st.base} ms: they never settle`,
        )
      let quiet = true
      for (const key of [...children.keys()]) {
        const c = children.get(key)
        if (!c) continue
        const before = c.got
        const a = await ask(key, { op: 'step', t, base: st.base })
        if (a && (a.got > 0 || c.got !== before)) quiet = false
      }
      if (quiet) return
    }
  }

  // Runs timers and frames in time order up to `target` (absolute), here and in every child,
  // yielding a task between callbacks so promise chains and MessageChannel schedulers (React) keep
  // up. The freeze stops it where it is.
  const advance = async (target) => {
    const gen = st.gen
    N.caf(st.keeper)
    for (let guard = 0; st.gen === gen; guard++) {
      if (guard === 200000)
        throw new Error(
          `the page scheduled 200000 callbacks before ${target - st.base} ms: it never settles`,
        )
      await ready()
      const own = ownNext()
      const t = children.size > 0 ? Math.min(own.at, await nextDue()) : own.at
      // Fix 3: a tick due at the target runs; the tolerance absorbs n * (1000 / rafHz) rounding.
      if (t > target + 1e-6 || st.gen !== gen) break
      // Every child is at t before this context's own callback at t runs, so a message it sends
      // is handled at t.
      if (children.size > 0) {
        st.now = Math.max(st.now, t)
        await settleChildren(st.now)
      }
      // Read again: the page's handlers of their messages may have set or cleared a timer.
      const mine = children.size > 0 ? ownNext() : own
      if (mine.at <= t) {
        const tick = nextTick()
        if (mine.next && mine.next.due <= tick) {
          st.now = Math.max(st.now, mine.next.due)
          fire(mine.next)
        } else {
          st.now = tick
          st.tickN++
          runFrame(st.now)
        }
        await yieldTask()
        // Fix 2: and one a promise or a MessageChannel task started after it, before time moves on.
        syncAll()
        if (children.size > 0) await settleChildren(st.now)
      }
    }
    if (st.gen === gen) st.now = target
    if (children.size > 0) await settleChildren(st.now)
    syncAll()
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
    syncAll()
  }
  if (st.free) {
    freezing = (async () => {
      while (st.free) {
        const target = t0 + Math.floor(N.perfNow() - realStart)
        if (target > st.now) await advance(target)
        if (st.free) await realWait(1)
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
    syncAll()
    return st.now - st.base
  }

  // What a frame still waits on: video seeks and loads, children starting, and the same in each
  // child. Each held video that waits on nothing is asked to put its frame on screen.
  const busy = async () => {
    syncVideos(true)
    let n = starting.size
    for (const v of isWorker
      ? []
      : new Set([...doc().querySelectorAll('video'), ...videos.keys()])) {
      const rec = videos.get(v)
      // A held video that cannot play played for the page all the same, so a fallback the page
      // shows a visitor when play() fails (a poster, an image) may be missing here.
      if (v.error && rec)
        limitOnce(
          videoName(v),
          `a video that could not be played (MediaError code ${v.error.code}): its play() resolved, so a fallback a visitor sees may be missing`,
        )
      if (!v.isConnected || v.error || rec?.stuck) continue
      // A seek landing, the frame shown still loading or not yet on screen, or one more seek due.
      if (v.seeking || (v.networkState === 2 && v.readyState < 2)) n++
      else if (
        rec &&
        (!presented(v, rec) || Math.abs(timeDesc.get.call(v) - target(v, rec)) > 1e-6)
      )
        n++
      // Its frame is presented, but Chrome may not have put it on screen: a paused video's frame
      // that comes while the one before it is not yet acknowledged is dropped, and stays off
      // screen until something asks for it again (#782). Asking for a frame callback does (the
      // compositor submits the frame it holds, if it has not), and is nothing if it is on screen.
      else if (rec && frameCallback) frameCallback.call(v, () => {})
    }
    for (const k of [...children.keys()]) {
      const a = await ask(k, { op: 'busy' })
      if (a) n += a.n
    }
    return n
  }

  // The frames of this document that have no clock, and the same in each child.
  const gather = async () => {
    const out = []
    if (!isWorker)
      for (const el of doc().querySelectorAll('iframe, frame')) {
        const win = el.contentWindow
        if (!win || children.has(win)) continue
        let url = el.src || 'about:blank'
        try {
          url = win.location.href
          // A frame of this origin with no script of its own runs nothing on any clock.
          if (url === 'about:blank' || url === 'about:srcdoc') continue
        } catch {}
        out.push(url)
      }
    for (const k of [...children.keys()]) {
      const a = await ask(k, { op: 'gather' })
      if (a && Array.isArray(a.unclocked)) out.push(...a.unclocked)
    }
    return out
  }

  // ---------- a child's side ----------
  // Its parent's questions, answered in order. Messages from the parent are FIFO, so a step
  // comes after every message the parent's page sent before it.
  if (isChild) {
    let gotFromParent = 0
    const toParent = (m) => {
      if (isWorker) N.postMessage(m)
      else w.parent.postMessage(m, '*')
    }
    const answer = (data, more) =>
      toParent({ [MARK]: 'answer', id: data.id, limits: st.limits.splice(0), ...more })
    let queue = Promise.resolve()
    const onControl = (data) => {
      queue = queue.then(async () => {
        const op = data[MARK]
        if (op === 'init') {
          st.now = data.now
          st.base = data.base
          alignTicks()
          started = true
        } else if (op === 'next') answer(data, { at: await nextDue() })
        else if (op === 'step') {
          if (data.base !== st.base) {
            st.base = data.base
            alignTicks()
          }
          // Nothing here is due before t: t is the earliest of all.
          if (data.t > st.now) st.now = data.t
          await advance(data.t)
          const got = gotFromParent
          gotFromParent = 0
          answer(data, { got })
        } else if (op === 'busy') answer(data, { n: await busy() })
        else if (op === 'gather') answer(data, { unclocked: await gather() })
      })
    }
    N.addEventListener(
      'message',
      (e) => {
        if (isFrame && e.source !== w.parent) return
        if (isControl(e.data)) {
          e.stopImmediatePropagation()
          onControl(e.data)
        } else {
          gotFromParent++
          // A worker's parent names a port it sends; a frame names one it is sent.
          if (isFrame && e.ports.length > 0) limitOnce(w.location.href, PORT_REASON)
        }
      },
      true,
    )
    // A worker that ends itself says so first, after every message it sent, so its parent stops
    // asking it.
    if (isWorker && typeof w.close === 'function') {
      const close = w.close.bind(w)
      w.close = function close_() {
        toParent({ [MARK]: 'bye', limits: st.limits.splice(0) })
        close()
      }
    }
    toParent({ [MARK]: 'hello' })
  }
  syncAll()
  if (!isWorker) keeper()
  w.__shadereraClock = {
    version: VERSION,
    seed: CFG.seed,
    rafHz: CFG.rafHz,
    timeOrigin: t0,
    epoch: st.dateOffset + t0,
    get started() {
      return started
    },
    advanceTo,
    afterInput,
    busy,
    /** The time now and the freeze, absolute, for a child that starts here. */
    time: () => ({ now: st.now, base: st.base }),
    /** Once frozen: how long after the first script the freeze came, in ms (0 unless CFG.free). */
    frozen: async () => {
      await freezing
      return st.base - t0
    },
    /** When an animation was first seen, in ms after the freeze, or null if it never was. */
    startOf: (a) => (st.started.has(a) ? st.started.get(a) - st.base : null),
    /** The animations first seen since the last call, in the order they were seen. */
    drain: () => st.fresh.splice(0),
    /** What the clock could not hold since the last call, here and in every child. */
    limits: () => st.limits.splice(0),
    /**
     * At the end: the frames here and in every child that have no clock, what the capture cannot
     * hold. The children's last limits come up with their answers, for limits() to take.
     */
    unclocked: gather,
    sync: () => {
      syncAll()
      return st.now - st.base
    },
    state: () => ({
      now: st.now - st.base,
      timers: st.timers.size,
      rafs: st.rafs.size,
      frames: st.frames,
      animations: st.anims.size,
      children: children.size,
      starting: [...starting.values()].map((s) => s.where),
    }),
  }
})
