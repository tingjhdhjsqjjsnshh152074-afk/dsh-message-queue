/**
 * Browser half of the message-queue bundle.
 *
 * A failing client entry aborts Web boot, so every stage here is contained: the module load,
 * the factory, and the registration each degrade to a no-op instead of throwing.
 */
const ENDPOINT = '/plugin/message-queue'

/**
 * Report one Client-half breadcrumb to the Host half.
 * @param stage - factory, apply, registered, render, mounted, or error.
 * @param note - optional detail.
 */
const reported = new Set()

function report(stage, note) {
  // One breadcrumb per stage per page load: the host uses them to confirm the browser half mounted.
  if (reported.has(stage)) return
  reported.add(stage)
  try {
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'hello', stage, note }),
    }).catch(() => {})
  } catch {
    // Reporting is diagnostics only; it never carries plugin behavior.
  }
}

/**
 * Build the Client plugin object.
 * @param require - browser module table accessor.
 * @returns the Cordis Client plugin.
 */
function createPlugin(require) {
  const React = require('react')
  const h = React.createElement
  let createPortal
  try {
    createPortal = require('react-dom').createPortal
  } catch {
    // Without react-dom the panel renders in place; the slot still works.
    createPortal = undefined
  }
  const POLL_MS = 4000
  const MINUTE = 60_000

  const STYLE = `
.mq-trigger{position:relative;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#6b6a66);cursor:pointer;transition:background .12s ease,color .12s ease}
.mq-trigger:hover{background:var(--dsw-alias-bg-layer-2,#efece5);color:var(--dsw-alias-label-primary,#1f1f1d)}
.mq-trigger[data-open="true"]{background:var(--dsw-alias-bg-layer-2,#efece5);color:var(--dsw-alias-label-primary,#1f1f1d)}
.mq-badge{position:absolute;top:-3px;right:-4px;min-width:15px;height:15px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-brand-primary,#2f6f5e);color:#fff;font-size:10px;line-height:15px;text-align:center;font-weight:600;box-shadow:0 0 0 2px var(--dsw-alias-bg-base,#fbfaf7)}
.mq-badge[data-warn="true"]{background:var(--dsw-alias-state-warn-primary,#a96700)}

.mq-panel *{box-sizing:border-box}
.mq-panel{position:fixed;z-index:60;right:20px;bottom:104px;width:min(396px,calc(100vw - 40px));max-height:min(70vh,620px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#1f1f1d);border:1px solid var(--dsw-alias-border-l2,#d4cec3);border-radius:16px;box-shadow:0 18px 44px rgba(0,0,0,.16),0 2px 6px rgba(0,0,0,.06);font-size:13px;line-height:20px;overflow:hidden}
.mq-head{display:flex;align-items:center;gap:8px;padding:14px 16px 10px;background:var(--dsw-alias-bg-base,#fff)}
.mq-head-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.mq-ttl{font-size:13.5px;font-weight:600;letter-spacing:.01em}
.mq-sub{font-size:11px;color:var(--dsw-alias-label-secondary,#98948c)}
.mq-sub b{color:var(--dsw-alias-state-warn-primary,#a96700);font-weight:600}
.mq-head-ops{margin-left:auto;display:flex;gap:2px}
.mq-ib{width:26px;height:26px;display:grid;place-items:center;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#706d67);cursor:pointer;font-size:13px;line-height:1;transition:background .12s ease,color .12s ease}
.mq-ib:hover{background:var(--dsw-alias-bg-layer-2,#efece5);color:var(--dsw-alias-label-primary,#1f1f1d)}

.mq-scroll{overflow:auto;padding:2px 8px 8px;flex:1 1 auto;min-height:0;background:var(--dsw-alias-bg-base,#fff)}
.mq-group{font-size:10.5px;letter-spacing:.08em;color:var(--dsw-alias-label-secondary,#98948c);padding:10px 10px 4px;text-transform:uppercase}
.mq-row{position:relative;display:flex;gap:9px;padding:8px 10px;border-radius:10px;transition:background .12s ease}
.mq-row:hover{background:var(--dsw-alias-bg-layer-2,#f3f0e9)}
.mq-row[data-missed="true"]{background:rgba(169,103,0,.06)}
.mq-dot{flex:0 0 auto;width:6px;height:6px;border-radius:999px;margin-top:7px;background:var(--dsw-alias-state-idle-primary,#98948c)}
.mq-dot[data-s="sending"]{background:#316fd0}
.mq-dot[data-s="missed"]{background:var(--dsw-alias-state-warn-primary,#a96700)}
.mq-dot[data-s="sent"]{background:var(--dsw-alias-state-success-primary,#25855a)}
.mq-main{flex:1;min-width:0;padding-right:52px}
.mq-row[data-missed="true"] .mq-main{padding-right:0}
.mq-text{font-size:12.5px;line-height:19px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;word-break:break-word}
.mq-row[data-sent="true"] .mq-text{color:var(--dsw-alias-label-secondary,#98948c)}
.mq-meta{display:flex;align-items:center;gap:7px;margin-top:3px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#98948c);flex-wrap:wrap}
.mq-meta .mq-sep{opacity:.5}
.mq-when{color:var(--dsw-alias-label-secondary,#706d67)}
.mq-when[data-soon="true"]{color:var(--dsw-alias-brand-primary,#2f6f5e);font-weight:600}
.mq-missed-note{color:var(--dsw-alias-state-warn-primary,#a96700)}
.mq-ops{position:absolute;right:8px;top:6px;display:flex;gap:3px;opacity:0;transition:opacity .12s ease}
.mq-row:hover .mq-ops{opacity:1}
.mq-op{width:22px;height:22px;display:grid;place-items:center;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#98948c);cursor:pointer;font-size:12px;line-height:1}
.mq-op:hover{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f1f1d);border-color:var(--dsw-alias-border-l1,#e6e1d8)}
.mq-op[data-danger="true"]:hover{color:var(--dsw-alias-state-error-primary,#c43d35);border-color:#ebc7c3}
.mq-inline-ops{display:flex;gap:6px;margin-top:6px}
.mq-inline-ops button{border:1px solid var(--dsw-alias-border-l1,#e6e1d8);background:var(--dsw-alias-bg-base,#fff);border-radius:999px;padding:2px 10px;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary,#706d67);cursor:pointer}
.mq-inline-ops button:hover{color:var(--dsw-alias-label-primary,#1f1f1d);border-color:var(--dsw-alias-border-l2,#d4cec3)}
.mq-inline-ops button[data-danger="true"]:hover{color:var(--dsw-alias-state-error-primary,#c43d35);border-color:#ebc7c3}
.mq-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:34px 18px 28px;color:var(--dsw-alias-label-secondary,#98948c);font-size:12px;line-height:18px;text-align:center}
.mq-empty svg{opacity:.45}

.mq-form{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1,#e6e1d8);padding:12px 16px 14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-base,#fff)}
.mq-ta{display:block;width:100%;min-height:56px;max-height:132px;resize:vertical;border:1px solid var(--dsw-alias-border-l1,#e6e1d8);border-radius:10px;padding:9px 11px;font:inherit;font-size:12.5px;line-height:19px;color:inherit;background:var(--dsw-alias-bg-base,#fff);outline:none;transition:border-color .12s ease,box-shadow .12s ease}
.mq-ta:focus{border-color:var(--dsw-alias-brand-primary,#2f6f5e);box-shadow:0 0 0 3px rgba(47,111,94,.12)}
.mq-choices{display:flex;gap:6px;flex-wrap:wrap}
.mq-pill{border:1px solid var(--dsw-alias-border-l1,#e6e1d8);background:transparent;border-radius:999px;padding:3px 11px;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary,#706d67);cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease,border-color .12s ease}
.mq-pill:hover{border-color:var(--dsw-alias-border-l2,#d4cec3);color:var(--dsw-alias-label-primary,#1f1f1d)}
.mq-pill[data-on="true"]{background:var(--dsw-alias-brand-primary,#2f6f5e);border-color:var(--dsw-alias-brand-primary,#2f6f5e);color:#fff;font-weight:600}
.mq-timing{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.mq-num{width:58px;border:1px solid var(--dsw-alias-border-l1,#e6e1d8);border-radius:8px;padding:4px 8px;font:inherit;font-size:12px;background:var(--dsw-alias-bg-base,#fff);color:inherit;outline:none}
.mq-num:focus{border-color:var(--dsw-alias-brand-primary,#2f6f5e)}
.mq-when-input{border:1px solid var(--dsw-alias-border-l1,#e6e1d8);border-radius:8px;padding:4px 8px;font:inherit;font-size:12px;background:var(--dsw-alias-bg-base,#fff);color:inherit;outline:none}
.mq-when-input:focus{border-color:var(--dsw-alias-brand-primary,#2f6f5e)}
.mq-summary{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#98948c)}
.mq-summary b{color:var(--dsw-alias-label-primary,#1f1f1d);font-weight:600}
.mq-foot{display:flex;align-items:center;gap:10px}
.mq-hint{margin-right:auto;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-secondary,#98948c);white-space:nowrap}
.mq-go{border:0;border-radius:9px;padding:6px 14px;font-size:12.5px;font-weight:600;background:var(--dsw-alias-brand-primary,#2f6f5e);color:#fff;cursor:pointer;transition:opacity .12s ease,transform .06s ease}
.mq-go:hover{opacity:.92}
.mq-go:active{transform:translateY(1px)}
.mq-go[disabled]{opacity:.4;cursor:not-allowed}
.mq-err{margin:8px 12px 0;padding:6px 10px;border-radius:9px;background:rgba(196,61,53,.08);color:var(--dsw-alias-state-error-primary,#c43d35);font-size:11.5px;line-height:17px}.mq-timefield{position:relative;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mq-timebtn{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--dsw-alias-border-l1,#e6e1d8);background:var(--dsw-alias-bg-base,#fff);border-radius:10px;padding:5px 11px;font-size:12.5px;color:var(--dsw-alias-label-primary,#1f1f1d);cursor:pointer;transition:border-color .12s ease,background .12s ease}
.mq-timebtn:hover{border-color:var(--dsw-alias-border-l2,#d4cec3)}
.mq-timebtn[data-open="true"]{border-color:var(--dsw-alias-brand-primary,#2f6f5e);box-shadow:0 0 0 3px rgba(47,111,94,.12)}
.mq-timebtn svg{color:var(--dsw-alias-label-secondary,#706d67)}
.mq-pop{position:absolute;left:0;bottom:calc(100% + 8px);z-index:70;width:264px;padding:10px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-overlay,#fffdf9);border:1px solid var(--dsw-alias-border-l2,#d4cec3);border-radius:13px;box-shadow:0 16px 36px rgba(0,0,0,.16)}
.mq-cal-head{display:flex;align-items:center;gap:6px}
.mq-cal-ttl{flex:1;text-align:center;font-size:12.5px;font-weight:600;letter-spacing:.01em}
.mq-nav{width:24px;height:24px;display:grid;place-items:center;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#706d67);cursor:pointer;font-size:13px;line-height:1}
.mq-nav:hover{background:var(--dsw-alias-bg-layer-2,#efece5);color:var(--dsw-alias-label-primary,#1f1f1d)}
.mq-week{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;font-size:10px;color:var(--dsw-alias-label-secondary,#98948c);text-align:center}
.mq-days{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.mq-day{height:26px;border:0;border-radius:7px;background:transparent;font-size:12px;color:var(--dsw-alias-label-primary,#1f1f1d);cursor:pointer;font-variant-numeric:tabular-nums}
.mq-day:hover{background:var(--dsw-alias-bg-layer-2,#efece5)}
.mq-day[data-mute="true"]{color:var(--dsw-alias-label-secondary,#b8b4ab);cursor:default}
.mq-day[data-mute="true"]:hover{background:transparent}
.mq-day[data-on="true"]{background:var(--dsw-alias-brand-primary,#2f6f5e);color:#fff;font-weight:600}
.mq-day[data-today="true"][data-on="false"]{box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,#d4cec3)}
.mq-clock{display:flex;align-items:center;gap:6px;border-top:1px solid var(--dsw-alias-border-l1,#e6e1d8);padding-top:8px}
.mq-unit{display:flex;align-items:center;gap:4px;flex:1}
.mq-unit .mq-nav{width:22px;height:22px}
.mq-unit-val{min-width:34px;text-align:center;font-size:13.5px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#1f1f1d)}
.mq-unit-lab{font-size:10.5px;color:var(--dsw-alias-label-secondary,#98948c)}
.mq-pop-foot{display:flex;gap:6px;justify-content:flex-end;border-top:1px solid var(--dsw-alias-border-l1,#e6e1d8);padding-top:8px}
.mq-pop-foot button{border:1px solid var(--dsw-alias-border-l1,#e6e1d8);background:transparent;border-radius:8px;padding:3px 11px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#706d67);cursor:pointer}
.mq-pop-foot button[data-primary="true"]{background:var(--dsw-alias-brand-primary,#2f6f5e);border-color:var(--dsw-alias-brand-primary,#2f6f5e);color:#fff;font-weight:600}
.mq-stepper{display:inline-flex;align-items:center;gap:2px;border:1px solid var(--dsw-alias-border-l1,#e6e1d8);border-radius:999px;padding:2px 4px;background:var(--dsw-alias-bg-base,#fff)}
.mq-step{width:20px;height:20px;display:grid;place-items:center;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#706d67);cursor:pointer;font-size:13px;line-height:1}
.mq-step:hover{background:var(--dsw-alias-bg-layer-2,#efece5);color:var(--dsw-alias-label-primary,#1f1f1d)}
.mq-step-val{min-width:52px;text-align:center;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
.mq-unit-input{width:34px;border:0;border-bottom:1px solid transparent;background:transparent;text-align:center;font:inherit;font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#1f1f1d);outline:none;padding:0 0 1px}
.mq-unit-input:hover{border-bottom-color:var(--dsw-alias-border-l2,#d4cec3)}
.mq-unit-input:focus{border-bottom-color:var(--dsw-alias-brand-primary,#2f6f5e)}
.mq-tabs{display:flex;align-items:center;gap:4px;padding:0 16px 8px;background:var(--dsw-alias-bg-base,#fff);border-bottom:1px solid var(--dsw-alias-border-l1,#e6e1d8)}
.mq-tab{border:0;background:transparent;border-radius:999px;padding:3px 11px;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary,#98948c);cursor:pointer;transition:background .12s ease,color .12s ease}
.mq-tab:hover{color:var(--dsw-alias-label-primary,#1f1f1d)}
.mq-tab[data-on="true"]{background:var(--dsw-alias-bg-layer-2,#f1eee7);color:var(--dsw-alias-label-primary,#1f1f1d);font-weight:600}
.mq-clear{margin-left:auto;border:0;background:transparent;font-size:11px;color:var(--dsw-alias-label-secondary,#98948c);cursor:pointer}
.mq-clear:hover{color:var(--dsw-alias-state-error-primary,#c43d35)}
`

  /**
   * @param value - number below ten.
   * @returns two digits.
   */
  function pad(value) {
    return String(value).padStart(2, '0')
  }

  /**
   * @param date - clock time.
   * @returns the `datetime-local` input value.
   */
  function localInput(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  /**
   * @param iso - instant.
   * @returns a short local day and time label.
   */
  function clockLabel(iso) {
    const at = new Date(iso)
    const now = new Date()
    const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
    if (at.toDateString() === now.toDateString()) return `今天 ${time}`
    const tomorrow = new Date(now.getTime() + 86_400_000)
    if (at.toDateString() === tomorrow.toDateString()) return `明天 ${time}`
    return `${at.getMonth() + 1}月${at.getDate()}日 ${time}`
  }

  /**
   * @param seconds - delay length.
   * @returns the human delay label.
   */
  function delayLabel(seconds) {
    if (seconds === 0) return '立即'
    if (seconds % 3600 === 0) return `${seconds / 3600} 小时`
    if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} 分钟`
    return `${seconds} 秒`
  }

  /**
   * @param item - queue item.
   * @returns its trigger label.
   */
  function whenLabel(item) {
    const trigger = item.trigger
    if (trigger.kind === 'at') return clockLabel(trigger.at)
    if (trigger.kind === 'after') return '本轮完成后'
    return `完成后 ${delayLabel(trigger.seconds)}`
  }

  /**
   * Whether a waiting item is close enough to deserve emphasis.
   * @param item - queue item.
   * @param now - current epoch milliseconds.
   * @returns whether its moment is within ten minutes.
   */
  function soonish(item, now) {
    if (item.trigger.kind !== 'at') return item.trigger.kind === 'after'
    const at = Date.parse(item.trigger.at)
    return Number.isFinite(at) && at - now <= 10 * MINUTE && at >= now
  }

  /**
   * @param item - queue item.
   * @param paused - whether the whole queue is paused.
   * @param head - whether it is the head of the pending items.
   * @returns the row's status label.
   */
  function statusLabel(item, paused, head) {
    if (item.status === 'sending') return '正在发送'
    if (item.status === 'missed') return '待确认'
    if (item.status === 'sent') return '已发送'
    if (paused) return '队列暂停'
    if (!head) return '等待前项'
    if (item.trigger.kind === 'after') return '等本轮跑完'
    return '等待到点'
  }

  /**
   * @param item - queue item.
   * @returns the status dot attribute.
   */
  function dotKind(item) {
    if (item.status === 'sending' || item.status === 'missed' || item.status === 'sent') return item.status
    return 'waiting'
  }

  /** @returns the clock glyph. */
  function ClockGlyph() {
    return h('svg', {
      viewBox: '0 0 24 24', width: 17, height: 17, fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true,
    }, h('circle', { cx: 12, cy: 12, r: 8.2 }), h('path', { d: 'M12 7.6V12l3 1.9' }))
  }

  /** @returns the empty-state glyph. */
  function EmptyGlyph() {
    return h('svg', {
      viewBox: '0 0 48 48', width: 40, height: 40, fill: 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    h('circle', { cx: 24, cy: 24, r: 15 }),
    h('path', { d: 'M24 15v9l6 3.6' }))
  }

  /**
   * @param label - accessible name.
   * @param glyph - visible glyph.
   * @param onClick - activation handler.
   * @param danger - whether the hover color is destructive.
   * @returns one hover action.
   */
  function hoverAction(label, glyph, onClick, danger) {
    return h('button', {
      type: 'button',
      className: 'mq-op',
      title: label,
      'aria-label': label,
      'data-danger': danger === true ? 'true' : 'false',
      onClick,
    }, glyph)
  }

  /** @returns the calendar glyph. */
  function CalendarGlyph() {
    return h('svg', {
      viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true,
    }, h('rect', { x: 4, y: 5.5, width: 16, height: 14.5, rx: 2.5 }), h('path', { d: 'M8 3.5V7M16 3.5V7M4 10h16' }))
  }

  /**
   * Read one hand-typed clock field as a bounded number.
   * @param text - raw input text.
   * @param max - inclusive upper bound.
   * @returns the clamped value; an empty or non-numeric entry reads as zero.
   */
  function clampDigits(text, max) {
    const digits = String(text).replace(/[^0-9]/g, '').slice(0, 2)
    if (digits === '') return 0
    return Math.min(Number(digits), max)
  }

  /**
   * Drawn date and time picker: no native calendar or number control.
   * @param props - current local `datetime-local` value and its change callback.
   */
  function TimeField(props) {
    const [open, setOpen] = React.useState(false)
    const parsed = Date.parse(props.value)
    const selected = Number.isFinite(parsed) ? new Date(parsed) : new Date()
    const [viewYear, setViewYear] = React.useState(selected.getFullYear())
    const [viewMonth, setViewMonth] = React.useState(selected.getMonth())
    const [hourText, setHourText] = React.useState(pad(selected.getHours()))
    const [minuteText, setMinuteText] = React.useState(pad(selected.getMinutes()))
    const rootRef = React.useRef(null)

    React.useEffect(() => {
      if (!open) return undefined
      const close = (event) => {
        if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
      }
      const onKey = (event) => {
        if (event.key === 'Escape') setOpen(false)
      }
      document.addEventListener('mousedown', close)
      document.addEventListener('keydown', onKey)
      return () => {
        document.removeEventListener('mousedown', close)
        document.removeEventListener('keydown', onKey)
      }
    }, [open])

    React.useEffect(() => {
      if (!open) return
      const target = Number.isFinite(Date.parse(props.value)) ? new Date(Date.parse(props.value)) : new Date()
      setViewYear(target.getFullYear())
      setViewMonth(target.getMonth())
      setHourText(pad(target.getHours()))
      setMinuteText(pad(target.getMinutes()))
    }, [open])

    const emit = (year, month, day, hh, mm) => {
      props.onChange(localInput(new Date(year, month, day, hh, mm, 0, 0)))
    }

    const dayCell = (day) => {
      const date = new Date(viewYear, viewMonth, day)
      const sameDay = date.getFullYear() === selected.getFullYear()
        && date.getMonth() === selected.getMonth()
        && date.getDate() === selected.getDate()
      const today = new Date()
      const past = date < new Date(today.getFullYear(), today.getMonth(), today.getDate())
      return h('button', {
        key: 'day-' + day,
        type: 'button',
        className: 'mq-day',
        'data-on': sameDay ? 'true' : 'false',
        'data-today': date.toDateString() === today.toDateString() ? 'true' : 'false',
        'data-mute': past ? 'true' : 'false',
        disabled: past,
        onClick: () => {
          emit(viewYear, viewMonth, day, clampDigits(hourText, 23), clampDigits(minuteText, 59))
          setOpen(false)
        },
      }, String(day))
    }

    const first = new Date(viewYear, viewMonth, 1)
    const blanks = (first.getDay() + 6) % 7
    const total = new Date(viewYear, viewMonth + 1, 0).getDate()
    const cells = []
    for (let i = 0; i < blanks; i += 1) cells.push(h('span', { key: 'blank-' + i }))
    for (let day = 1; day <= total; day += 1) cells.push(dayCell(day))

    const shiftMonth = (delta) => {
      const next = new Date(viewYear, viewMonth + delta, 1)
      setViewYear(next.getFullYear())
      setViewMonth(next.getMonth())
    }

    const step = (value, delta, size, max) => (value + delta * size + max) % max
    const hourValue = clampDigits(hourText, 23)
    const minuteValue = clampDigits(minuteText, 59)

    return h('div', { className: 'mq-timefield', ref: rootRef },
      h('button', {
        type: 'button',
        className: 'mq-timebtn',
        'data-open': open ? 'true' : 'false',
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => setOpen(value => !value),
      }, h(CalendarGlyph), clockLabel(new Date(Date.parse(props.value) || Date.now()).toISOString())),
      open ? h('div', { className: 'mq-pop', role: 'dialog', 'aria-label': '选择发送时间' },
        h('div', { className: 'mq-cal-head' },
          h('button', { type: 'button', className: 'mq-nav', 'aria-label': '上个月', onClick: () => shiftMonth(-1) }, '‹'),
          h('span', { className: 'mq-cal-ttl' }, `${viewYear} 年 ${viewMonth + 1} 月`),
          h('button', { type: 'button', className: 'mq-nav', 'aria-label': '下个月', onClick: () => shiftMonth(1) }, '›'),
        ),
        h('div', { className: 'mq-week' }, ['一', '二', '三', '四', '五', '六', '日'].map(label => h('span', { key: label }, label))),
        h('div', { className: 'mq-days' }, cells),
        h('div', { className: 'mq-clock' },
          h('div', { className: 'mq-unit' },
            h('button', {
              type: 'button', className: 'mq-nav', 'aria-label': '前一小时',
              onClick: () => {
                const next = step(hourValue, -1, 1, 24)
                setHourText(pad(next))
                emit(viewYear, viewMonth, selected.getDate(), next, minuteValue)
              },
            }, '‹'),
            h('input', {
              className: 'mq-unit-input',
              inputMode: 'numeric',
              maxLength: 2,
              'aria-label': '小时',
              value: hourText,
              onChange: (event) => {
                const raw = event.target.value.replace(/[^0-9]/g, '').slice(0, 2)
                setHourText(raw)
                if (raw !== '') emit(viewYear, viewMonth, selected.getDate(), Math.min(Number(raw), 23), minuteValue)
              },
              onBlur: () => setHourText(pad(hourValue)),
            }),
            h('span', { className: 'mq-unit-lab' }, '时'),
            h('button', {
              type: 'button', className: 'mq-nav', 'aria-label': '后一小时',
              onClick: () => {
                const next = step(hourValue, 1, 1, 24)
                setHourText(pad(next))
                emit(viewYear, viewMonth, selected.getDate(), next, minuteValue)
              },
            }, '›'),
          ),
          h('div', { className: 'mq-unit' },
            h('button', {
              type: 'button', className: 'mq-nav', 'aria-label': '前五分钟',
              onClick: () => {
                const next = step(minuteValue, -1, 5, 60)
                setMinuteText(pad(next))
                emit(viewYear, viewMonth, selected.getDate(), hourValue, next)
              },
            }, '‹'),
            h('input', {
              className: 'mq-unit-input',
              inputMode: 'numeric',
              maxLength: 2,
              'aria-label': '分钟',
              value: minuteText,
              onChange: (event) => {
                const raw = event.target.value.replace(/[^0-9]/g, '').slice(0, 2)
                setMinuteText(raw)
                if (raw !== '') emit(viewYear, viewMonth, selected.getDate(), hourValue, Math.min(Number(raw), 59))
              },
              onBlur: () => setMinuteText(pad(minuteValue)),
            }),
            h('span', { className: 'mq-unit-lab' }, '分'),
            h('button', {
              type: 'button', className: 'mq-nav', 'aria-label': '后五分钟',
              onClick: () => {
                const next = step(minuteValue, 1, 5, 60)
                setMinuteText(pad(next))
                emit(viewYear, viewMonth, selected.getDate(), hourValue, next)
              },
            }, '›'),
          ),
        ),
        h('div', { className: 'mq-pop-foot' },
          h('button', {
            type: 'button', 'data-primary': 'true',
            onClick: () => {
              emit(viewYear, viewMonth, selected.getDate(), hourValue, minuteValue)
              setOpen(false)
            },
          }, '确定'),
        ),
      ) : null,
    )
  }

  /**
   * Composer clock control and its queue panel.
   * @param props - Session-scoped slot props.
   */
  function QueueControl(props) {
    report('render')
    const sessionId = props.sessionId
    const [queue, setQueue] = React.useState(undefined)
    const [open, setOpen] = React.useState(false)
    const [error, setError] = React.useState(undefined)
    const [pending, setPending] = React.useState(false)
    const [draft, setDraft] = React.useState('')
    const [mode, setMode] = React.useState('after')
    const [atValue, setAtValue] = React.useState(() => localInput(new Date(Date.now() + 10 * MINUTE)))
    const [minutes, setMinutes] = React.useState('15')
    const [repeatMode, setRepeatMode] = React.useState('once')
    const [repeatTimes, setRepeatTimes] = React.useState('3')
    const [now, setNow] = React.useState(() => Date.now())
    const [tab, setTab] = React.useState('queue')

    React.useEffect(() => {
      report('mounted')
      const ticker = setInterval(() => setNow(Date.now()), 30_000)
      return () => clearInterval(ticker)
    }, [])

    const loadedBuild = React.useRef(undefined)

    const call = React.useCallback(async (payload) => {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, ...payload }),
      })
      const body = await response.json()
      if (body.ok !== true) throw new Error(body.error ?? '请求失败')
      setQueue(body.state)
      // A newly installed browser half replaces this one; reload once so it takes effect.
      if (loadedBuild.current === undefined) loadedBuild.current = body.state.build
      else if (body.state.build !== undefined && loadedBuild.current !== body.state.build) location.reload()
      return body.state
    }, [sessionId])

    React.useEffect(() => {
      let alive = true
      const refresh = () => {
        void call({ op: 'state' }).catch((cause) => {
          if (alive) setError(cause instanceof Error ? cause.message : String(cause))
        })
      }
      refresh()
      const timer = setInterval(refresh, POLL_MS)
      return () => {
        alive = false
        clearInterval(timer)
      }
    }, [call])

    React.useEffect(() => {
      if (!open) return undefined
      const onKey = (event) => {
        if (event.key === 'Escape') setOpen(false)
      }
      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
    }, [open])

    const act = React.useCallback(async (payload) => {
      setPending(true)
      setError(undefined)
      try {
        await call(payload)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setPending(false)
      }
    }, [call])

    const items = queue?.items ?? []
    const waiting = items.filter(item => item.status === 'waiting')
    const missed = items.filter(item => item.status === 'missed')
    const sent = items.filter(item => item.status === 'sent')
    const paused = queue?.paused === true
    const pendingCount = waiting.length + missed.length


    const submit = () => {
      const text = draft.trim()
      if (text.length === 0) return
      let payload
      if (mode === 'at') {
        const at = Date.parse(atValue)
        if (!Number.isFinite(at)) {
          setError('请选择发送时间')
          return
        }
        payload = { op: 'add', text, trigger: { kind: 'at', at: new Date(at).toISOString() } }
      } else if (mode === 'delay') {
        const seconds = Math.round(Number(minutes) * 60)
        if (!Number.isFinite(seconds) || seconds < 0) {
          setError('请输入完成后的间隔分钟数')
          return
        }
        payload = { op: 'add', text, trigger: { kind: 'delay', seconds } }
      } else {
        payload = { op: 'add', text, trigger: { kind: 'after' } }
      }
      if (mode !== 'at' && repeatMode !== 'once') {
        payload.repeat = repeatMode === 'endless'
          ? { endless: true }
          : { remaining: Math.min(99, Math.max(1, Math.round(Number(repeatTimes) || 1))) }
      }
      void act(payload).then(() => {
        setDraft('')
        setError(undefined)
      })
    }

    const row = (item, index) => {
      const head = item.status === 'waiting' && waiting[0]?.id === item.id
      const isMissed = item.status === 'missed'
      const isSent = item.status === 'sent'
      const quiet = item.status !== 'waiting'
      const ops = item.status === 'waiting'
        ? [
          head ? null : hoverAction('上移', '↑', () => act({ op: 'move', id: item.id, direction: 'up' })),
          hoverAction('取消', '✕', () => act({ op: 'cancel', id: item.id }), true),
        ]
        : []
      return h('div', {
        className: 'mq-row',
        key: item.id,
        'data-missed': isMissed ? 'true' : 'false',
        'data-sent': isSent ? 'true' : 'false',
      },
      h('span', { className: 'mq-dot', 'data-s': dotKind(item) }),
      h('div', { className: 'mq-main' },
        h('div', { className: 'mq-text' }, item.text),
        h('div', { className: 'mq-meta' },
          h('span', {}, statusLabel(item, paused, head)),
          h('span', { className: 'mq-sep' }, '·'),
          h('span', {
            className: 'mq-when',
            'data-soon': !quiet && soonish(item, now) ? 'true' : 'false',
          }, isSent && item.sentAt !== undefined ? `已于 ${clockLabel(item.sentAt)} 发出` : whenLabel(item)),
          item.repeat !== undefined
            ? h('span', { className: 'mq-sep' }, '·')
            : null,
          item.repeat !== undefined
            ? h('span', {}, item.repeat.endless === true
              ? '循环中'
              : `剩余 ${item.repeat.remaining} 轮`)
            : null,
        ),
        isMissed
          ? h('div', { className: 'mq-inline-ops' },
            h('button', {
              type: 'button',
              onClick: () => act({ op: 'confirm', id: item.id, action: 'send' }),
            }, '现在发出'),
            h('button', {
              type: 'button',
              'data-danger': 'true',
              onClick: () => act({ op: 'confirm', id: item.id, action: 'drop' }),
            }, '丢弃'))
          : null,
      ),
      item.status === 'waiting'
        ? h('div', { className: 'mq-ops' }, ops)
        : null,
      )
    }

    const group = (title, list) => (list.length === 0 ? null : h('div', null,
      h('div', { className: 'mq-group' }, title),
      list.map((item, index) => row(item, index))
    ))

    const panelBody = open ? h('div', { className: 'mq-panel', role: 'dialog', 'aria-label': '定时消息队列' },
      h('div', { className: 'mq-head' },
        h('div', { className: 'mq-head-text' },
          h('span', { className: 'mq-ttl' }, '定时消息'),
          h('span', { className: 'mq-sub' },
            waiting.length === 0 && missed.length === 0
              ? '这个对话还没有待发消息'
              : `${waiting.length} 条待发`),
          missed.length > 0
            ? h('span', { className: 'mq-sub' }, h('b', null, `${missed.length} 条错过了时间，等你确认`))
            : null,
        ),
        h('div', { className: 'mq-head-ops' },
          h('button', {
            type: 'button', className: 'mq-ib', title: paused ? '继续队列' : '暂停队列',
            'aria-label': paused ? '继续队列' : '暂停队列',
            onClick: () => act({ op: 'pause', paused: !paused }),
          }, paused ? '▶' : '⏸'),
          h('button', {
            type: 'button', className: 'mq-ib', title: '关闭', 'aria-label': '关闭',
            onClick: () => setOpen(false),
          }, '✕'),
        ),
      ),
      error !== undefined ? h('div', { className: 'mq-err' }, error) : null,
      h('div', { className: 'mq-tabs' },
        h('button', {
          type: 'button', className: 'mq-tab', 'data-on': tab === 'queue' ? 'true' : 'false',
          onClick: () => setTab('queue'),
        }, '队列' + (pendingCount > 0 ? ' · ' + pendingCount : '')),
        h('button', {
          type: 'button', className: 'mq-tab', 'data-on': tab === 'history' ? 'true' : 'false',
          onClick: () => setTab('history'),
        }, '历史' + (sent.length > 0 ? ' · ' + sent.length : '')),
        tab === 'history' && sent.length > 0
          ? h('button', {
            type: 'button', className: 'mq-clear', disabled: pending,
            onClick: () => act({ op: 'clearSent' }),
          }, '清空')
          : null,
      ),
      h('div', { className: 'mq-scroll' },
        tab === 'history'
          ? (sent.length === 0
            ? h('div', { className: 'mq-empty' },
              h(EmptyGlyph),
              h('span', null, '还没有发出去的消息。'))
            : sent.slice().reverse().map((item, index) => row(item, index)))
          : (pendingCount === 0
            ? h('div', { className: 'mq-empty' },
              h(EmptyGlyph),
              h('span', null, '写一条消息，选个时机，放进队列。'),
              h('span', null, '它会在轮到你的时候作为你的消息发出去。'))
            : [
              missed.length > 0 ? group('待确认', missed) : null,
              waiting.length > 0 ? group('待发', waiting) : null,
            ]),
      ),
      h('div', { className: 'mq-form' },
        h('textarea', {
          className: 'mq-ta',
          placeholder: '这条消息要说什么…',
          value: draft,
          onChange: event => setDraft(event.target.value),
        }),
        h('div', { className: 'mq-choices' },
          h('button', {
            type: 'button', className: 'mq-pill', 'data-on': mode === 'after' ? 'true' : 'false',
            onClick: () => setMode('after'),
          }, '本轮完成后'),
          h('button', {
            type: 'button', className: 'mq-pill', 'data-on': mode === 'delay' ? 'true' : 'false',
            onClick: () => setMode('delay'),
          }, '完成后间隔'),
          h('button', {
            type: 'button', className: 'mq-pill', 'data-on': mode === 'at' ? 'true' : 'false',
            onClick: () => setMode('at'),
          }, '指定时间'),
        ),
        mode === 'at'
          ? null
          : h('div', { className: 'mq-choices' },
            h('button', {
              type: 'button', className: 'mq-pill', 'data-on': repeatMode === 'once' ? 'true' : 'false',
              onClick: () => setRepeatMode('once'),
            }, '只发一次'),
            h('button', {
              type: 'button', className: 'mq-pill', 'data-on': repeatMode === 'times' ? 'true' : 'false',
              onClick: () => setRepeatMode('times'),
            }, '重复'),
            repeatMode === 'times'
              ? h('div', { className: 'mq-stepper' },
                h('button', {
                  type: 'button', className: 'mq-step', 'aria-label': '减少一次',
                  onClick: () => setRepeatTimes(String(Math.max(1, Number(repeatTimes || '1') - 1))),
                }, '−'),
                h('span', { className: 'mq-step-val' }, `${Number(repeatTimes || '1')} 轮`),
                h('button', {
                  type: 'button', className: 'mq-step', 'aria-label': '增加一次',
                  onClick: () => setRepeatTimes(String(Math.min(99, Number(repeatTimes || '1') + 1))),
                }, '+'),
              )
              : null,
            h('button', {
              type: 'button', className: 'mq-pill', 'data-on': repeatMode === 'endless' ? 'true' : 'false',
              onClick: () => setRepeatMode('endless'),
            }, '一直重复'),
          ),
        mode === 'delay'
            ? h('div', { className: 'mq-timing' },
              h('div', { className: 'mq-stepper' },
                h('button', {
                  type: 'button', className: 'mq-step', 'aria-label': '减少五分钟',
                  onClick: () => setMinutes(String(Math.max(0, Number(minutes || '0') - 5))),
                }, '−'),
                h('span', { className: 'mq-step-val' },
                  Number(minutes || '0') === 0 ? '立即' : `${Number(minutes || '0')} 分钟`),
                h('button', {
                  type: 'button', className: 'mq-step', 'aria-label': '增加五分钟',
                  onClick: () => setMinutes(String(Number(minutes || '0') + 5)),
                }, '+'),
              ),
              ['0', '5', '15', '60'].map(value => h('button', {
                key: value,
                type: 'button',
                className: 'mq-pill',
                'data-on': minutes === value ? 'true' : 'false',
                onClick: () => setMinutes(value),
              }, value === '0' ? '立即' : value === '60' ? '1 小时' : `${value} 分钟`)))
            : mode === 'at' ? h('div', { className: 'mq-timing' },
              [
                { label: '+10 分钟', add: 10 * MINUTE },
                { label: '+30 分钟', add: 30 * MINUTE },
                { label: '+1 小时', add: 60 * MINUTE },
                { label: '明早 9:00', tomorrow: true },
              ].map(choice => h('button', {
                key: choice.label,
                type: 'button',
                className: 'mq-pill',
                onClick: () => {
                  if (choice.add !== undefined) {
                    const target = new Date(Date.now() + choice.add)
                    setAtValue(localInput(target))
                  } else {
                    const target = new Date()
                    target.setDate(target.getDate() + 1)
                    target.setHours(9, 0, 0, 0)
                    setAtValue(localInput(target))
                  }
                },
              }, choice.label)),

            ) : null,
        mode === 'at'
          ? h(TimeField, { value: atValue, onChange: setAtValue })
          : null,
        h('div', { className: 'mq-foot' },
          h('span', { className: 'mq-hint' }, '前一条跑完才发下一条'),
          h('button', {
            type: 'button', className: 'mq-go', disabled: pending || draft.trim().length === 0,
            onClick: submit,
          }, pending ? '提交中…' : '加入队列'),
        ),
      ),
    ) : null

    const panel = panelBody !== null && createPortal !== undefined
      ? createPortal(panelBody, document.body)
      : panelBody

    return h(React.Fragment, null,
      h('style', { key: 'style' }, STYLE),
      h('button', {
        key: 'trigger',
        type: 'button',
        className: 'mq-trigger',
        'data-open': open ? 'true' : 'false',
        title: '定时消息队列',
        'aria-label': '定时消息队列',
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => setOpen(value => !value),
      },
        h(ClockGlyph),
        waiting.length > 0 ? h('span', {
          className: 'mq-badge',
          'data-warn': missed.length > 0 ? 'true' : 'false',
        }, String(waiting.length)) : null,
      ),
      panel,
    )
  }

  return {
    inject: ['slots'],
    apply(ctx) {
      report('apply')
      try {
        ctx.slots.inject('conversation.input.right', () => {
          report('injected')
          const handle = ctx.slots.register({
            name: 'conversation.input.right',
            id: 'message-queue',
            order: 40,
          }, QueueControl)
          report('registered', typeof handle)
          return handle
        })
      } catch (error) {
        report('error', error instanceof Error ? error.message : String(error))
      }
    },
  }
}

try {
  report('factory')
  window.__ModuleLoader__.load({
    id: 'dsh-message-queue',
    factory(require) {
      try {
        return createPlugin(require)
      } catch (error) {
        report('error', `factory: ${error instanceof Error ? error.message : String(error)}`)
        return { apply() {} }
      }
    },
  })
} catch (error) {
  // A broken Client half must never take Web boot down with it.
  report('error', `load: ${error instanceof Error ? error.message : String(error)}`)
}
