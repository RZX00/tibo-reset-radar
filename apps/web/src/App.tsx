import type { ActivityStatus, ForecastSnapshot, SourcePostObserved } from "@tibo-radar/contracts";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Github,
  Info,
  LoaderCircle,
  Moon,
  Radio,
  RefreshCw,
  Share2,
  Sun,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { track } from "./analytics.js";
import { loadRadar, RadarApiError } from "./api.js";
import {
  detectLang,
  dictionaries,
  LANGS,
  type Lang,
  localeFor,
  rememberLang,
  type Strings,
} from "./i18n.js";

type RadarData = Awaited<ReturnType<typeof loadRadar>>;

const TIMEZONES = ["Asia/Shanghai", "UTC", "America/Los_Angeles", "Europe/London"];
const TIBO_AVATAR_URL =
  "https://pbs.twimg.com/profile_images/2075819673263001600/pj1vyX6I_400x400.jpg";
const TIBO_TIMEZONE = "America/Los_Angeles";
const GROUP_QR_URL = "/community/ewo-api-group-qr.png";

export interface RoutinePresentation {
  phase: "sleeping" | "awake" | "social" | "winding_down";
  label: string;
  localTime: string;
}

export function getRoutinePresentation(
  now: Date,
  lastPublicActivityAt: string | null,
  t: Strings = dictionaries.zh,
): RoutinePresentation {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIBO_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const localTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const minuteOfDay = hour * 60 + minute;
  const lastActivity = lastPublicActivityAt ? Date.parse(lastPublicActivityAt) : Number.NaN;
  const activityAge = now.getTime() - lastActivity;

  if (Number.isFinite(lastActivity) && activityAge >= 0 && activityAge <= 30 * 60_000) {
    return { phase: "awake", label: t.routine.awakeRecent, localTime };
  }
  if (minuteOfDay >= 30 && minuteOfDay < 9 * 60 + 30) {
    return { phase: "sleeping", label: t.routine.sleeping, localTime };
  }
  if (minuteOfDay >= 21 * 60 && minuteOfDay < 23 * 60 + 30) {
    return { phase: "social", label: t.routine.social, localTime };
  }
  if (minuteOfDay >= 23 * 60 + 30 || minuteOfDay < 30) {
    return { phase: "winding_down", label: t.routine.windingDown, localTime };
  }
  return { phase: "awake", label: t.routine.awake, localTime };
}

// 主结论：根据7天累计概率 + reset状态 生成一句话答案
interface VerdictInfo {
  level: "confirmed" | "high" | "medium" | "low" | "none";
  headline: string;
  sub: string;
}

function getVerdict(
  resetState: string,
  within168h: number,
  within48h: number,
  within24h: number,
  allCalm: boolean,
  t: Strings,
): VerdictInfo {
  if (resetState === "confirmed_reset") {
    return {
      level: "confirmed",
      headline: t.verdict.confirmed.headline,
      sub: t.verdict.confirmed.sub,
    };
  }
  if (resetState === "candidate_confirmation") {
    return {
      level: "high",
      headline: t.verdict.candidate.headline,
      sub: t.verdict.candidate.sub,
    };
  }
  if (within24h >= 0.3) {
    return {
      level: "high",
      headline: t.verdict.high24.headline,
      sub: t.verdict.high24.sub(percent(within24h)),
    };
  }
  if (within48h >= 0.3) {
    return {
      level: "high",
      headline: t.verdict.high48.headline,
      sub: t.verdict.high48.sub(percent(within48h)),
    };
  }
  if (within48h >= 0.15) {
    return {
      level: "medium",
      headline: t.verdict.medium.headline,
      sub: t.verdict.medium.sub(percent(within48h)),
    };
  }
  if (within168h >= 0.15) {
    return {
      level: "low",
      headline: t.verdict.low.headline,
      sub: t.verdict.low.sub(percent(within48h), percent(within168h)),
    };
  }
  return {
    level: "none",
    headline: allCalm ? t.verdict.none.headlineCalm : t.verdict.none.headline,
    sub: t.verdict.none.sub(percent(within48h)),
  };
}

export function getActivityPresentation(
  activity: {
    status: ActivityStatus;
    likelySleeping?: boolean;
    sleepWindowUtc?: { sampleSize: number } | null;
  },
  t: Strings = dictionaries.zh,
): { label: string; note: string } {
  if (activity.status === "quiet" && activity.likelySleeping) {
    const sampleSize = activity.sleepWindowUtc?.sampleSize;
    return {
      label: t.sleep.label,
      note: sampleSize ? t.sleep.note(sampleSize) : t.sleep.noteFallback,
    };
  }
  return t.activity[activity.status];
}

function reasonLabel(reason: string, t: Strings): string {
  return t.reasons[reason] ?? t.reasonFallback;
}

// 根据 topReasonCodes 生成一句自然语言信号依据
function buildSignalSentence(
  topReasons: [string, number][],
  activityStatus: ActivityStatus,
  eventCount: number,
  t: Strings,
): string {
  const hasSignal = topReasons.some(([r]) =>
    [
      "rules_future",
      "rules_rolling_out_now",
      "rules_completed",
      "rules_milestone",
      "rules_incident",
      "rules_incident_and_milestone",
    ].includes(r),
  );
  if (hasSignal) {
    const labels = topReasons
      .filter(([r]) => r !== `${activityStatus}_activity`)
      .slice(0, 2)
      .map(([r]) => reasonLabel(r, t));
    return t.signals.detected(labels.join(t === dictionaries.zh ? "、" : ", "), eventCount);
  }
  if (activityStatus === "active") return t.signals.active;
  if (activityStatus === "cooling") return t.signals.cooling;
  return t.signals.quiet;
}

const skeletonKeys = ["day-1", "day-2", "day-3", "day-4", "day-5", "day-6", "day-7"];

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function precisePercent(value: number): string {
  const percentage = value * 100;
  return percentage > 0 && percentage < 1
    ? `${percentage.toFixed(1)}%`
    : `${Math.round(percentage)}%`;
}

function probabilityLabel(value: number, t: Strings): string {
  if (value >= 0.35) return t.probability.high;
  if (value >= 0.2) return t.probability.medium;
  if (value >= 0.06) return t.probability.low;
  return t.probability.veryLow;
}

function dateTime(value: string, timezone: string, locale = "zh-CN"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function timeRange(startAt: string, endAt: string, timezone: string, locale = "zh-CN"): string {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const sameLocalDay = localDay(start, timezone) === localDay(end, timezone);
  return sameLocalDay
    ? `${dateTime(startAt, timezone, locale)}–${clockTime(endAt, timezone, locale)}`
    : `${dateTime(startAt, timezone, locale)}–${dateTime(endAt, timezone, locale)}`;
}

function clockTime(value: string, timezone: string, locale = "zh-CN"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function weekday(value: string, timezone: string, locale = "zh-CN"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: "short",
  }).format(new Date(value));
}

function shortDate(value: string, timezone: string, locale = "zh-CN"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    month: "numeric",
    day: "numeric",
  }).format(new Date(value));
}

function localDay(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function daysSince(value: string): number {
  return Math.floor((Date.now() - new Date(value).getTime()) / (1000 * 60 * 60 * 24));
}

function relativeTime(value: string | null, t: Strings): string {
  if (!value) return t.relative.none;
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return t.relative.seconds(seconds);
  if (seconds < 3600) return t.relative.minutes(Math.floor(seconds / 60));
  return t.relative.hours(Math.floor(seconds / 3600));
}

function Skeleton() {
  return (
    <main id="main-content" className="radar-shell" aria-busy="true">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-band" />
      <div className="forecast-strip">
        {skeletonKeys.map((key) => (
          <div className="skeleton skeleton-day" key={key} />
        ))}
      </div>
    </main>
  );
}

function ErrorState({ message, onRetry, t }: { message: string; onRetry: () => void; t: Strings }) {
  return (
    <main id="main-content" className="radar-shell state-page">
      <AlertTriangle size={28} />
      <h1>{t.error.title}</h1>
      <p>{message}</p>
      <button className="command-button" type="button" onClick={onRetry}>
        <RefreshCw size={16} /> {t.error.retry}
      </button>
    </main>
  );
}

function EventRow({
  event,
  timezone,
  t,
  locale,
}: {
  event: SourcePostObserved;
  timezone: string;
  t: Strings;
  locale: string;
}) {
  const label =
    event.sourceKind === "reply"
      ? t.events.reply
      : event.sourceKind === "quote"
        ? t.events.quote
        : t.events.post;
  return (
    <article className="event-row">
      <div className="event-avatar" aria-hidden="true">
        {event.authorAvatarUrl ? <img src={event.authorAvatarUrl} alt="" /> : <Radio size={18} />}
      </div>
      <div className="event-copy">
        <div className="event-byline">
          <strong>{event.authorDisplayName ?? "Tibo"}</strong>
          <span>@{event.authorHandle ?? "tibo"}</span>
          <span>{label}</span>
          <time dateTime={event.createdAt}>{dateTime(event.createdAt, timezone, locale)}</time>
        </div>
        <p>{event.text}</p>
      </div>
      <a
        className="icon-link"
        href={event.sourceUrl}
        target="_blank"
        rel="noreferrer"
        aria-label={t.events.openOnX}
        title={t.events.openTitle}
      >
        <ExternalLink size={17} />
      </a>
    </article>
  );
}

export function App() {
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
  );
  const [data, setData] = useState<RadarData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [shareFeedback, setShareFeedback] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [qrOpen, setQrOpen] = useState(false);
  const [lang, setLang] = useState<Lang>(detectLang);
  const t = dictionaries[lang];
  const locale = localeFor(lang);

  useEffect(() => {
    rememberLang(lang);
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  const refresh = useCallback(async () => {
    const controller = new AbortController();
    setRefreshing(true);
    setError(null);
    try {
      setData(await loadRadar(timezone, controller.signal));
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(caught instanceof RadarApiError ? caught.message : t.error.offline);
      }
    } finally {
      setRefreshing(false);
    }
    return () => controller.abort();
  }, [timezone, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!qrOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQrOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [qrOpen]);

  const forecast: ForecastSnapshot | null = data?.forecast ?? null;

  const allCalm = useMemo(() => {
    if (!forecast) return true;
    return forecast.days.every((d) => d.signalLevel === "calm");
  }, [forecast]);

  const topReasons = useMemo(() => {
    if (!forecast) return [] as [string, number][];
    const counts = new Map<string, number>();
    for (const reason of forecast.days
      .flatMap((item) => item.buckets)
      .flatMap((item) => item.topReasonCodes)) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 4) as [string, number][];
  }, [forecast]);

  async function share() {
    if (!forecast) return;
    setShareFeedback(null);
    const payload = {
      title: "Tibo Reset Radar",
      text: t.shareText(
        percent(forecast.cumulative.within24h),
        percent(forecast.cumulative.within48h),
        percent(forecast.cumulative.within168h),
      ),
      url: window.location.href,
    };
    try {
      if (navigator.share) {
        await navigator.share(payload);
        setShareFeedback(t.shareFeedback.shared);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(window.location.href);
        setShareFeedback(t.shareFeedback.copied);
      } else {
        throw new Error("share is unavailable");
      }
      track("share_forecast", { probability: Math.round(forecast.cumulative.within168h * 100) });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setShareFeedback(t.shareFeedback.cancelled);
      } else {
        setShareFeedback(t.shareFeedback.failed);
      }
    }
  }

  if (!data && !error) return <Skeleton />;
  if (!data && error) return <ErrorState message={error} onRetry={() => void refresh()} t={t} />;
  if (!data || !forecast) return null;

  const activity = getActivityPresentation(data.status.activity, t);
  const resetState = data.reset.state;
  const verdict = getVerdict(
    resetState,
    forecast.cumulative.within168h,
    forecast.cumulative.within48h,
    forecast.cumulative.within24h,
    allCalm,
    t,
  );
  const signalSentence = buildSignalSentence(
    topReasons,
    data.status.activity.status,
    data.events.items.length,
    t,
  );
  const identity = data.events.items.find((item) => item.authorHandle || item.authorDisplayName);
  const displayName = identity?.authorDisplayName ?? "Tibo";
  const handle = identity?.authorHandle ?? "thsottiaux";
  const routine = getRoutinePresentation(currentTime, data.status.activity.lastPublicActivityAt, t);
  const freshnessLabel =
    forecast.dataFreshness.status === "fresh"
      ? t.freshness.fresh
      : forecast.dataFreshness.status === "delayed"
        ? t.freshness.delayed
        : t.freshness.stale;
  const firstDay = forecast.days[0];
  const firstDayPeak = firstDay
    ? Math.max(...firstDay.buckets.map((bucket) => bucket.intervalProbability))
    : 0;
  const peakDayProbability = Math.max(...forecast.days.map((item) => item.intervalProbability));
  const peakDayIndex = forecast.days.findIndex(
    (item) => item.intervalProbability === peakDayProbability,
  );

  return (
    <main id="main-content" className="radar-shell">
      {/* ── 页头 ── */}
      <header className="masthead">
        <div className="masthead-brand">
          <div className="brand-avatar">
            <span aria-hidden="true">T</span>
            <img
              src={TIBO_AVATAR_URL}
              alt={t.avatarAlt}
              referrerPolicy="no-referrer"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          </div>
          <div>
            <span className="edition">
              {data.status.demoMode ? t.edition.demo : ""}
              {t.edition.outlook}
            </span>
            <h1>Tibo Reset Radar</h1>
            <div className="identity-line">
              <span className="identity-person">
                {displayName} · @{handle}
              </span>
              <span className="routine-chip" data-phase={routine.phase} title={t.routineTitle}>
                {routine.phase === "sleeping" || routine.phase === "winding_down" ? (
                  <Moon size={14} aria-hidden="true" />
                ) : routine.phase === "social" ? (
                  <Radio size={14} aria-hidden="true" />
                ) : (
                  <Sun size={14} aria-hidden="true" />
                )}
                <strong>{routine.label}</strong>
                <span>{t.routine.localTime(routine.localTime)}</span>
              </span>
              <span className="last-reset-inline">
                <span>{t.lastReset.label}</span>
                {data.reset.event?.occurredAt ? (
                  <>
                    <strong>{t.lastReset.daysAgo(daysSince(data.reset.event.occurredAt))}</strong>
                    <time dateTime={data.reset.event.occurredAt}>
                      {dateTime(data.reset.event.occurredAt, timezone, locale)}
                    </time>
                  </>
                ) : (
                  <strong>{t.lastReset.none}</strong>
                )}
              </span>
            </div>
          </div>
        </div>
        <div className="masthead-actions">
          <label className="timezone-control lang-control">
            <span>{t.langLabel}</span>
            <select
              value={lang}
              onChange={(event) => setLang(event.target.value as Lang)}
              aria-label={t.langLabel}
            >
              {LANGS.map((item) => (
                <option value={item} key={item}>
                  {dictionaries[item].langName}
                </option>
              ))}
            </select>
          </label>
          <label className="timezone-control">
            <span>{t.actions.timezone}</span>
            <select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
              {[timezone, ...TIMEZONES.filter((item) => item !== timezone)].map((item) => (
                <option value={item} key={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <button
            className="icon-button"
            type="button"
            onClick={() => void refresh()}
            aria-label={t.actions.refresh}
            title={t.actions.refreshTitle}
            disabled={refreshing}
          >
            {refreshing ? <LoaderCircle className="spin" size={18} /> : <RefreshCw size={18} />}
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => void share()}
            aria-label={t.actions.share}
            title={t.actions.shareTitle}
          >
            <Share2 size={18} />
          </button>
          <a
            className="icon-button"
            href="https://github.com/RZX00/tibo-reset-radar"
            target="_blank"
            rel="noreferrer"
            aria-label={t.actions.github}
            title="GitHub"
            onClick={() => track("github_click")}
          >
            <Github size={18} />
          </a>
        </div>
      </header>

      {shareFeedback ? (
        <p className="action-feedback" role="status" aria-live="polite">
          {shareFeedback}
        </p>
      ) : null}

      {data.status.demoMode ? <div className="demo-band">{t.demoBand}</div> : null}

      {/* ── 区域一：主结论 ── */}
      <section
        className="verdict-hero"
        data-level={verdict.level}
        aria-label={t.verdictAria}
        aria-live="polite"
      >
        <div className="verdict-icon">
          {verdict.level === "confirmed" ? (
            <CheckCircle2 size={36} />
          ) : verdict.level === "high" || verdict.level === "medium" ? (
            <AlertTriangle size={36} />
          ) : (
            <Activity size={36} />
          )}
        </div>
        <div className="verdict-body">
          <details className="state-explainer">
            <summary className="current-state">
              <span className="status-dot" data-status={data.status.activity.status} />
              <span>
                {t.currentState("")}
                <strong>{activity.label}</strong>
              </span>
              <Info className="state-info-icon" size={13} aria-hidden="true" />
            </summary>
            <div className="state-explanation-panel">
              <strong>{t.stateExplainer}</strong>
              <ul>
                {(
                  Object.entries(t.activity) as [ActivityStatus, { label: string; note: string }][]
                ).map(([status, meta]) => (
                  <li key={status} data-current={status === data.status.activity.status}>
                    <span className="status-dot" data-status={status} />
                    <span>
                      <strong className="state-option-label">{meta.label}</strong>
                      <small className="state-option-note">{meta.note}</small>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </details>
          <p className="verdict-headline">{verdict.headline}</p>
          <p className="verdict-sub">{verdict.sub}</p>
        </div>
        <section className="headline-probabilities" aria-label={t.headline.aria}>
          <figure
            aria-label={t.headline.figureAria(
              t.headline.within24h,
              percent(forecast.cumulative.within24h),
            )}
          >
            <span>{t.headline.within24h}</span>
            <strong>{percent(forecast.cumulative.within24h)}</strong>
            <small>{t.headline.caption}</small>
          </figure>
          <figure
            aria-label={t.headline.figureAria(
              t.headline.within48h,
              percent(forecast.cumulative.within48h),
            )}
          >
            <span>{t.headline.within48h}</span>
            <strong>{percent(forecast.cumulative.within48h)}</strong>
            <small>{t.headline.caption}</small>
          </figure>
          <figure
            aria-label={t.headline.figureAria(
              t.headline.within168h,
              percent(forecast.cumulative.within168h),
            )}
          >
            <span>{t.headline.within168h}</span>
            <strong>{percent(forecast.cumulative.within168h)}</strong>
            <small>{t.headline.caption}</small>
          </figure>
        </section>
      </section>

      {/* ── 区域三：天气式预测 ── */}
      <section className="weather-forecast" aria-labelledby="weather-heading">
        <div className="weather-heading">
          <div>
            <h2 id="weather-heading">{t.weather.heading}</h2>
            <p>{t.weather.note}</p>
          </div>
          {peakDayIndex >= 0 ? (
            <p className="peak-day-note">
              {t.weather.peak(peakDayIndex + 1, percent(peakDayProbability))}
            </p>
          ) : null}
        </div>

        {firstDay ? (
          <section className="today-forecast" aria-label={t.weather.todayAria}>
            <div className="today-summary">
              <div>
                <span>{t.weather.todaySummary}</span>
                <strong>{percent(forecast.cumulative.within24h)}</strong>
              </div>
              <p>{t.weather.todayBuckets}</p>
            </div>
            <div className="hourly-strip">
              {firstDay.buckets.map((bucket) => (
                <article
                  className="hourly-window"
                  data-peak={bucket.intervalProbability === firstDayPeak}
                  key={bucket.index}
                  aria-label={t.weather.bucketAria(
                    `${clockTime(bucket.startAt, timezone, locale)}–${clockTime(bucket.endAt, timezone, locale)}`,
                    precisePercent(bucket.intervalProbability),
                  )}
                >
                  <span className="hourly-range">
                    {clockTime(bucket.startAt, timezone, locale)}–
                    {clockTime(bucket.endAt, timezone, locale)}
                  </span>
                  <strong>{precisePercent(bucket.intervalProbability)}</strong>
                  <small>{probabilityLabel(bucket.intervalProbability, t)}</small>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <ol className="daily-list" aria-label={t.weather.dailyAria}>
          {forecast.days.map((item, index) => {
            return (
              <li
                className="daily-row"
                data-peak={index === peakDayIndex}
                key={item.dayIndex}
                aria-label={t.weather.dayAria(
                  item.dayIndex,
                  timeRange(item.startAt, item.endAt, timezone, locale),
                  percent(item.intervalProbability),
                )}
              >
                <div className="daily-date">
                  <strong>
                    {index === 0 ? t.weather.firstDay : weekday(item.startAt, timezone, locale)}
                  </strong>
                  <span>{shortDate(item.startAt, timezone, locale)}</span>
                </div>
                <strong className="daily-probability">{percent(item.intervalProbability)}</strong>
                <div className="daily-signal">
                  <span>{probabilityLabel(item.intervalProbability, t)}</span>
                </div>
              </li>
            );
          })}
        </ol>
        <p className="window-disclaimer">{t.weather.disclaimer}</p>
      </section>

      {/* ── 区域四：信号依据 ── */}
      <section className="signal-summary" aria-label={t.signals.aria}>
        <p className="signal-sentence">{signalSentence}</p>
        <button
          className="events-toggle"
          type="button"
          onClick={() => setEventsOpen((v) => !v)}
          aria-expanded={eventsOpen}
        >
          <span>
            <strong>{t.signals.toggle}</strong>
            <small>{t.signals.count(data.events.items.length)}</small>
          </span>
          <ChevronDown size={18} data-open={eventsOpen} />
        </button>
        <div className="events-collapse" data-open={eventsOpen}>
          {eventsOpen ? (
            <div>
              {data.events.items.length ? (
                data.events.items.map((event) => (
                  <EventRow
                    key={event.postId}
                    event={event}
                    timezone={timezone}
                    t={t}
                    locale={locale}
                  />
                ))
              ) : (
                <p className="empty-events">{t.signals.empty}</p>
              )}
            </div>
          ) : null}
        </div>
      </section>

      <footer className="footer-line">
        <div className="footer-notes">
          <p>{t.footer.disclaimer}</p>
          <p className="data-footnote">
            <span className="status-dot" data-status={forecast.dataFreshness.status} />
            {freshnessLabel} ·{" "}
            {t.footer.updated(relativeTime(forecast.dataFreshness.lastObservedAt, t))} ·{" "}
            {t.footer.source}
          </p>
        </div>
        <span className="footer-brand">
          {t.footer.poweredPrefix}
          <a
            className="ewo-logo"
            href="https://api.ewo.so"
            target="_blank"
            rel="noreferrer"
            aria-label={t.footer.brandLink}
            onClick={() => track("ewo_click")}
          >
            <img src="/brand/ewo-api-lockup.svg" alt="ewo API" width="107" height="22" />
          </a>
          {t.footer.poweredSuffix}
          <button
            className="group-qr-thumb"
            type="button"
            onClick={() => setQrOpen(true)}
            aria-label={t.community.enlarge}
            title={t.community.label}
          >
            <img src={GROUP_QR_URL} alt={t.community.label} width="40" height="40" />
          </button>
        </span>
      </footer>

      {qrOpen ? (
        <div
          className="qr-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t.community.title}
          onClick={(event) => {
            // Only the backdrop dismisses; clicks that land on the card keep it open.
            if (event.target === event.currentTarget) setQrOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQrOpen(false);
          }}
        >
          <div className="qr-card">
            <strong>{t.community.title}</strong>
            <img src={GROUP_QR_URL} alt={t.community.label} width="280" height="280" />
            <small>{t.community.expiry}</small>
            <button className="command-button" type="button" onClick={() => setQrOpen(false)}>
              {t.community.close}
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
