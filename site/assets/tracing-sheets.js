/* Interactive hero. Render one shared timeline for the intro and hover playback. */
"use strict";
(() => {
  const root = document.getElementById("research-tracing-sheets");
  if (!root) return;
  const find = (selector) => root.querySelector(selector);
  const surface = find(".rts-surface");
  const scene = find(".rts-scene");
  const socket = find(".rts-socket");
  const port = find(".rts-paper-port");
  const cable = find(".rts-cable-line");
  const signal = find(".rts-signal");
  const bottom = find(".rts-bottom");
  const top = find(".rts-top");
  const pencil = find(".rts-pencil");
  const penShift = find(".rts-pen-shift");
  const ink = find(".rts-ink");
  const circleStroke = find(".rts-circle-stroke");
  const extraInk = Array.from(ink.querySelectorAll("path")).filter((path) => path !== circleStroke);
  const windowRect = find(".rts-curve-window");
  const sampleMark = find(".rts-registered-sample");
  const guides = find(".rts-register");
  const guideLines = guides.querySelectorAll("path");
  const guidePoints = guides.querySelectorAll("circle");
  const statusMarks = root.querySelectorAll(".rts-state");
  const count = find(".rts-count");
  const observations = ["rts-sample", "rts-measure"].map((id) =>
    Array.from(root.querySelectorAll('.rts-observations use[href="#' + id + '"]')),
  );
  const shown = observations.map((row) => row.length);
  const strokeLength = circleStroke.getTotalLength();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const starts = { method: 1360, plot: 2670, pencil: 3640, open: 4930, close: 6400, rest: 7160 };
  const period = 7900;
  const unit = (value) => Math.max(0, Math.min(1, value));
  const ease = (value) => {
    const t = unit(value);
    return t * t * (3 - 2 * t);
  };
  let spread = -1,
    lastPlot = -1,
    cableLength = 0,
    lastInk = -1;
  let frame = 0,
    startedAt = 0,
    playing = false;
  let introPending = !reduced.matches,
    introElapsed = 0;
  let hovering = false,
    toggled = false,
    suppressed = false,
    inView = false;
  let pointerKind = "";
  const setOpacity = (element, value) => {
    element.style.opacity = String(value);
  };

  function point(x, y, matrix) {
    const p = scene.createSVGPoint();
    p.x = x;
    p.y = y;
    return p.matrixTransform(matrix);
  }

  function connectCable() {
    const sceneMatrix = scene.getScreenCTM(),
      portMatrix = port.getScreenCTM();
    if (!sceneMatrix || !portMatrix || !sceneMatrix.a) return;
    const inverse = sceneMatrix.inverse(),
      box = socket.getBoundingClientRect();
    const start = point(box.left + box.width / 2, box.top + box.height / 2, inverse);
    const end = point(1.5, 112, portMatrix).matrixTransform(inverse);
    cable.setAttribute(
      "d",
      "M " +
        start.x +
        " " +
        start.y +
        " C " +
        (start.x + 37) +
        " " +
        start.y +
        " " +
        (end.x - 48) +
        " " +
        end.y +
        " " +
        end.x +
        " " +
        end.y,
    );
    cableLength = cable.getTotalLength();
  }

  function sheets(amount) {
    if (amount === spread) return;
    spread = amount;
    bottom.setAttribute("transform", "translate(" + -40 * amount + " " + 50 * amount + ")");
    top.setAttribute("transform", "translate(" + 43 * amount + " " + -57 * amount + ")");
    pencil.setAttribute("transform", "translate(" + 44 * amount + " " + -34 * amount + ") rotate(" + 2 * amount + ")");
    const x = 410.56,
      y = 156.36;
    const bx = x - 40 * amount,
      by = y + 50 * amount;
    const tx = x + 43 * amount,
      ty = y - 57 * amount;
    guideLines[0].setAttribute("d", "M" + bx + " " + by + "L" + x + " " + y);
    guideLines[1].setAttribute("d", "M" + x + " " + y + "L" + tx + " " + ty);
    guidePoints[0].setAttribute("cx", bx);
    guidePoints[0].setAttribute("cy", by);
    guidePoints[2].setAttribute("cx", tx);
    guidePoints[2].setAttribute("cy", ty);
    setOpacity(guides, 0.86 * ease((amount - 0.27) / 0.73));
    connectCable();
  }

  function expose(index, progress) {
    const row = observations[index],
      next = Math.round(row.length * unit(progress)),
      previous = shown[index];
    for (let i = Math.min(next, previous); i < Math.max(next, previous); i++) {
      setOpacity(row[i], next > previous ? 1 : 0);
    }
    shown[index] = next;
  }

  function trace(progress) {
    const value = unit(progress);
    if (value === lastPlot) return;
    lastPlot = value;
    windowRect.setAttribute("width", String(318 * value));
    setOpacity(sampleMark, value >= 0.72 ? 1 : 0);
  }

  function pulse(progress) {
    const visible = progress >= 0 && progress < 1 && cableLength > 0;
    setOpacity(signal, visible ? 1 : 0);
    if (!visible) return;
    const pos = cable.getPointAtLength(cableLength * ease(progress));
    signal.setAttribute("cx", pos.x);
    signal.setAttribute("cy", pos.y);
  }

  function handwriting(fraction) {
    const value = unit(fraction);
    if (value === lastInk) return;
    lastInk = value;
    const written = unit((value - 0.13) / 0.65);
    const lift = value < 0.13 ? ease(value / 0.13) : 1 - ease((value - 0.78) / 0.22);
    setOpacity(ink, written > 0 ? 1 : 0);
    circleStroke.style.strokeDasharray = "1";
    circleStroke.style.strokeDashoffset = String(1 - written);
    for (const extra of extraInk) setOpacity(extra, ease((value - 0.78) / 0.18));
    if (lift === 0) {
      penShift.removeAttribute("transform");
      return;
    }
    const strokeMatrix = circleStroke.getScreenCTM(),
      penMatrix = pencil.getScreenCTM();
    if (!strokeMatrix || !penMatrix || !penMatrix.a) return;
    const tip = circleStroke
      .getPointAtLength(written * strokeLength)
      .matrixTransform(strokeMatrix)
      .matrixTransform(penMatrix.inverse());
    penShift.setAttribute("transform", "translate(" + (tip.x - 429) * lift + " " + (tip.y - 150) * lift + ")");
  }

  function stage(name) {
    if (root.dataset.phase === name && root.dataset.initialized) return;
    root.dataset.initialized = "true";
    root.dataset.phase = name;
    statusMarks[0].textContent = name === "baseline" ? "▶" : "✓";
    statusMarks[1].textContent = name === "baseline" ? "·" : name === "method" ? "▶" : "✓";
    count.textContent = name === "baseline" ? "0/2" : name === "method" ? "1/2" : "2/2";
  }

  function still(expanded = false) {
    stage("idle");
    expose(0, 1);
    expose(1, 1);
    trace(1);
    handwriting(1);
    sheets(expanded ? 1 : 0);
    pulse(-1);
  }

  function paint(t) {
    const name =
      t < starts.method
        ? "baseline"
        : t < starts.plot
          ? "method"
          : t < starts.pencil
            ? "plotting"
            : t < starts.open
              ? "review"
              : t < starts.close
                ? "open"
                : t < starts.rest
                  ? "closing"
                  : "rest";
    stage(name);
    expose(0, (t - 330) / 900);
    expose(1, (t - starts.method - 330) / 890);
    trace((t - starts.plot) / 820);
    handwriting((t - starts.pencil) / 1000);
    const separation = t < starts.close ? ease((t - starts.open) / 710) : 1 - ease((t - starts.close) / 760);
    sheets(separation);
    pulse(t < starts.method ? t / 330 : t < starts.plot ? (t - starts.method) / 330 : -1);
  }

  const wantsLoop = () => !suppressed && (hovering || toggled);
  const canSeeFigure = () => inView && !document.hidden;

  function rest() {
    if (playing && introPending) {
      introElapsed = Math.min(period, Math.max(0, performance.now() - startedAt));
    }
    playing = false;
    cancelAnimationFrame(frame);
    frame = 0;
    const expanded = reduced.matches && canSeeFigure() && wantsLoop();
    surface.setAttribute("aria-pressed", String(expanded));
    still(expanded);
  }

  function tick(now) {
    if (!playing) return;
    let elapsed = now - startedAt;
    if (elapsed >= period) {
      // Finishing the visit's intro and continuing on hover share this boundary.
      introPending = false;
      introElapsed = 0;
      if (!wantsLoop() || !canSeeFigure()) {
        rest();
        return;
      }
      elapsed %= period;
      startedAt = now - elapsed;
    }
    paint(elapsed);
    frame = requestAnimationFrame(tick);
  }

  function sync() {
    if (!canSeeFigure() || reduced.matches || (!introPending && !wantsLoop())) {
      rest();
      return;
    }
    if (playing) return;
    playing = true;
    surface.setAttribute("aria-pressed", "true");
    const elapsed = introPending ? introElapsed : 0;
    startedAt = performance.now() - elapsed;
    paint(elapsed);
    frame = requestAnimationFrame(tick);
  }

  function enter(event) {
    if (event.pointerType === "touch") return;
    hovering = true;
    suppressed = false;
    sync();
  }

  function leave(event) {
    if (event.pointerType === "touch") return;
    hovering = false;
    toggled = false;
    suppressed = false;
    sync();
  }

  function pauseByUser() {
    introPending = false;
    introElapsed = 0;
    toggled = false;
    suppressed = true;
    rest();
  }

  function visible(next) {
    inView = next;
    if (next && matchMedia("(any-hover: hover)").matches) hovering = root.matches(":hover");
    if (!next) {
      hovering = false;
      toggled = false;
      suppressed = false;
    }
    sync();
  }

  root.addEventListener("pointerenter", enter);
  root.addEventListener("pointerleave", leave);
  surface.addEventListener("pointerdown", (event) => {
    pointerKind = event.pointerType;
  });
  surface.addEventListener("click", (event) => {
    // Mouse playback follows the entire illustration; taps and keyboard presses toggle it.
    if (event.detail !== 0 && pointerKind !== "touch") return;
    if (playing || (reduced.matches && wantsLoop())) {
      pauseByUser();
      return;
    }
    toggled = true;
    suppressed = false;
    sync();
  });
  surface.addEventListener("blur", () => {
    toggled = false;
    sync();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (playing || wantsLoop())) pauseByUser();
  });
  document.addEventListener("visibilitychange", sync);
  reduced.addEventListener("change", () => {
    if (reduced.matches) {
      introPending = false;
      introElapsed = 0;
    }
    sync();
  });

  if (typeof ResizeObserver === "function") new ResizeObserver(connectCable).observe(root);
  else window.addEventListener("resize", connectCable);
  window.addEventListener("pagehide", () => visible(false));
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      const box = root.getBoundingClientRect();
      visible(box.bottom > 0 && box.top < innerHeight);
    }
  });

  still();
  surface.hidden = false;
  if (typeof IntersectionObserver === "function") {
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible(entry.isIntersecting && entry.intersectionRatio >= 0.1);
      },
      { threshold: [0, 0.1] },
    );
    observer.observe(root);
  } else visible(true);
})();
