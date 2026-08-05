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

type RadarData = Awaited<ReturnType<typeof loadRadar>>;

const TIMEZONES = ["Asia/Shanghai", "UTC", "America/Los_Angeles", "Europe/London"];
const TIBO_AVATAR_URL =
  "https://pbs.twimg.com/profile_images/2075819673263001600/pj1vyX6I_400x400.jpg";
const TIBO_TIMEZONE = "America/Los_Angeles";

export interface RoutinePresentation {
  phase: "sleeping" | "awake" | "social" | "winding_down";
  label: string;
  localTime: string;
}

export function getRoutinePresentation(
  now: Date,
  lastPublicActivityAt: string | null,
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
    return { phase: "awake", label: "醒着 · 刚刚有公开活动", localTime };
  }
  if (minuteOfDay >= 30 && minuteOfDay < 9 * 60 + 30) {
    return { phase: "sleeping", label: "大概率睡觉", localTime };
  }
  if (minuteOfDay >= 21 * 60 && minuteOfDay < 23 * 60 + 30) {
    return { phase: "social", label: "通常在刷推", localTime };
  }
  if (minuteOfDay >= 23 * 60 + 30 || minuteOfDay < 30) {
    return { phase: "winding_down", label: "可能准备休息", localTime };
  }
  return { phase: "awake", label: "大概率醒着", localTime };
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
): VerdictInfo {
  if (resetState === "confirmed_reset") {
    return {
      level: "confirmed",
      headline: "Reset 已确认",
      sub: "权威来源已宣布，账户配额即将恢复。实际到账时间因账户而异。",
    };
  }
  if (resetState === "candidate_confirmation") {
    return {
      level: "high",
      headline: "发现候选信号，正在核实",
      sub: "系统检测到疑似确认信号，正在保守核对权威来源，请稍后刷新。",
    };
  }
  if (within24h >= 0.3) {
    return {
      level: "high",
      headline: "今天可能性较高，建议持续关注",
      sub: `未来 24 小时累计概率 ${percent(within24h)}，信号较强，推荐今天保持关注。`,
    };
  }
  if (within48h >= 0.3) {
    return {
      level: "high",
      headline: "近两天可能性较高，建议留意",
      sub: `未来 48 小时累计概率 ${percent(within48h)}，信号有所增强，建议今明两天关注。`,
    };
  }
  if (within48h >= 0.15) {
    return {
      level: "medium",
      headline: "近两天有一定可能性",
      sub: `未来 48 小时累计概率 ${percent(within48h)}，存在一定信号，建议偶尔查看。`,
    };
  }
  if (within168h >= 0.15) {
    return {
      level: "low",
      headline: "信号较弱，本周可能性低",
      sub: `未来 48 小时 ${percent(within48h)}，7 天累计 ${percent(within168h)}，当前无明确信号。`,
    };
  }
  return {
    level: "none",
    headline: allCalm ? "暂无信号，无需特别关注" : "信号平静，持续监测中",
    sub: `未来 48 小时概率 ${percent(within48h)}，依据历史基线估算，近期无异常信号。`,
  };
}

const activityMeta: Record<ActivityStatus, { label: string; note: string }> = {
  active: { label: "活跃", note: "30 分钟内有公开活动" },
  cooling: { label: "降温", note: "公开活动正在减少" },
  quiet: { label: "安静", note: "近期没有新公开动态" },
  data_delayed: { label: "数据延迟", note: "采集暂时无法确认" },
};

export function getActivityPresentation(activity: {
  status: ActivityStatus;
  likelySleeping?: boolean;
  sleepWindowUtc?: { sampleSize: number } | null;
}): { label: string; note: string } {
  if (activity.status === "quiet" && activity.likelySleeping) {
    const sampleSize = activity.sleepWindowUtc?.sampleSize;
    return {
      label: "可能在睡觉",
      note: sampleSize
        ? `按近 30 天 ${sampleSize} 条公开动态推测，当前处于低活跃时段`
        : "按历史公开活动时段推测，当前可能正在休息",
    };
  }
  return activityMeta[activity.status];
}

const reasonLabels: Record<string, string> = {
  recent_activity: "近期活动",
  cadence_0_24h: "Reset 后 24 小时冷却期",
  cadence_24_48h: "距上次 Reset 1–2 天",
  cadence_48_72h: "距上次 Reset 2–3 天",
  cadence_3_4d: "接近平均 Reset 间隔",
  cadence_4_7d: "已超过平均 Reset 间隔",
  cadence_7d_plus: "距上次 Reset 已超过 7 天",
  post_activity_high: "发帖量高于平时",
  post_activity_normal: "发帖量接近平时",
  post_activity_low: "发帖量低于平时",
  post_activity_baseline_unavailable: "发帖历史不足，未作修正",
  circadian_sleep: "当前处于常规睡眠时段",
  circadian_awake: "当前处于常规清醒时段",
  circadian_social: "当前处于晚间活跃时段",
  circadian_winding_down: "当前可能准备休息",
  active_activity: "近期公开活动",
  cooling_activity: "活动热度下降",
  quiet_activity: "低活动基线",
  data_delayed_activity: "数据延迟",
  rules_none: "没有明确 Reset 信号",
  rules_future: "未来 Reset 承诺",
  rules_rolling_out_now: "Reset 正在进行",
  rules_completed: "Reset 已完成语义",
  rules_limited: "有限范围 Reset",
  rules_retracted: "Reset 撤回语义",
  rules_ambiguous: "Reset 语义不确定",
  rules_reset_mention: "Reset 相关表述",
  rules_milestone: "里程碑进展",
  rules_incident: "故障信号",
  rules_incident_and_milestone: "事件与里程碑信号",
  source_not_authoritative: "来源非权威",
  source_not_first_party_statement: "不是第一方表述",
  banked_reset_ignored: "储备 Reset 已忽略",
  banked_reset_forecast_only: "储备 Reset 仅用于预测",
  authoritative_retraction: "权威撤回声明",
  retraction_requires_deterministic_evidence: "撤回证据仍需确认",
  no_completed_reset_claim: "没有已完成 Reset 声明",
  future_or_uncertain_language: "未来或不确定表述",
  completion_requires_deterministic_evidence: "完成证据仍需确认",
  authoritative_completed_reset: "权威完成声明",
};

function reasonLabel(reason: string): string {
  return reasonLabels[reason] ?? "其他信号";
}

// 根据 topReasonCodes 生成一句自然语言信号依据
function buildSignalSentence(
  topReasons: [string, number][],
  activityStatus: ActivityStatus,
  eventCount: number,
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
      .map(([r]) => reasonLabel(r));
    return `检测到相关信号：${labels.join("、")}。参考了近 24 小时 ${eventCount} 条公开动态。`;
  }
  if (activityStatus === "active")
    return `Tibo 近期活跃，暂无明确 Reset 相关表述，当前依据历史周期估算。`;
  if (activityStatus === "cooling")
    return `Tibo 近期活动减少，暂无 Reset 信号，当前依据历史周期估算。`;
  return `Tibo 近期无新公开动态，当前完全依据历史基线估算，无可靠信号参考。`;
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

function probabilityLabel(value: number): string {
  if (value >= 0.35) return "较高";
  if (value >= 0.2) return "中等";
  if (value >= 0.06) return "较低";
  return "很低";
}

function dateTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function timeRange(startAt: string, endAt: string, timezone: string): string {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const sameLocalDay = localDay(start, timezone) === localDay(end, timezone);
  return sameLocalDay
    ? `${dateTime(startAt, timezone)}–${clockTime(endAt, timezone)}`
    : `${dateTime(startAt, timezone)}–${dateTime(endAt, timezone)}`;
}

function clockTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function weekday(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    weekday: "short",
  }).format(new Date(value));
}

function shortDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
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

function relativeTime(value: string | null): string {
  if (!value) return "暂无";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
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

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main id="main-content" className="radar-shell state-page">
      <AlertTriangle size={28} />
      <h1>雷达暂时离线</h1>
      <p>{message}</p>
      <button className="command-button" type="button" onClick={onRetry}>
        <RefreshCw size={16} /> 重新连接
      </button>
    </main>
  );
}

function EventRow({ event, timezone }: { event: SourcePostObserved; timezone: string }) {
  const label =
    event.sourceKind === "reply" ? "回复" : event.sourceKind === "quote" ? "引用" : "帖子";
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
          <time dateTime={event.createdAt}>{dateTime(event.createdAt, timezone)}</time>
        </div>
        <p>{event.text}</p>
      </div>
      <a
        className="icon-link"
        href={event.sourceUrl}
        target="_blank"
        rel="noreferrer"
        aria-label="在 X 查看原帖"
        title="在 X 查看"
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

  const refresh = useCallback(async () => {
    const controller = new AbortController();
    setRefreshing(true);
    setError(null);
    try {
      setData(await loadRadar(timezone, controller.signal));
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(
          caught instanceof RadarApiError
            ? caught.message
            : "无法连接到 Radar API。请检查服务后重试。",
        );
      }
    } finally {
      setRefreshing(false);
    }
    return () => controller.abort();
  }, [timezone]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

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
      text: `未来 24 小时 Reset 概率 ${percent(forecast.cumulative.within24h)}，未来 48 小时 ${percent(forecast.cumulative.within48h)}，未来 7 天 ${percent(forecast.cumulative.within168h)}`,
      url: window.location.href,
    };
    try {
      if (navigator.share) {
        await navigator.share(payload);
        setShareFeedback("分享成功");
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(window.location.href);
        setShareFeedback("链接已复制");
      } else {
        throw new Error("share is unavailable");
      }
      track("share_forecast", { probability: Math.round(forecast.cumulative.within168h * 100) });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setShareFeedback("已取消分享");
      } else {
        setShareFeedback("分享失败，请稍后重试");
      }
    }
  }

  if (!data && !error) return <Skeleton />;
  if (!data && error) return <ErrorState message={error} onRetry={() => void refresh()} />;
  if (!data || !forecast) return null;

  const activity = getActivityPresentation(data.status.activity);
  const resetState = data.reset.state;
  const verdict = getVerdict(
    resetState,
    forecast.cumulative.within168h,
    forecast.cumulative.within48h,
    forecast.cumulative.within24h,
    allCalm,
  );
  const signalSentence = buildSignalSentence(
    topReasons,
    data.status.activity.status,
    data.events.items.length,
  );
  const identity = data.events.items.find((item) => item.authorHandle || item.authorDisplayName);
  const displayName = identity?.authorDisplayName ?? "Tibo";
  const handle = identity?.authorHandle ?? "thsottiaux";
  const routine = getRoutinePresentation(currentTime, data.status.activity.lastPublicActivityAt);
  const freshnessLabel =
    forecast.dataFreshness.status === "fresh"
      ? "数据正常"
      : forecast.dataFreshness.status === "delayed"
        ? "数据延迟"
        : "数据陈旧";
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
              alt="Tibo 头像"
              referrerPolicy="no-referrer"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          </div>
          <div>
            <span className="edition">
              {data.status.demoMode ? "DEMO DATA · " : ""}NEXT RESET OUTLOOK
            </span>
            <h1>Tibo Reset Radar</h1>
            <div className="identity-line">
              <span className="identity-person">
                {displayName} · @{handle}
              </span>
              <span
                className="routine-chip"
                data-phase={routine.phase}
                title="根据 Tibo 的常规作息推测；近期公开活动优先"
              >
                {routine.phase === "sleeping" || routine.phase === "winding_down" ? (
                  <Moon size={14} aria-hidden="true" />
                ) : routine.phase === "social" ? (
                  <Radio size={14} aria-hidden="true" />
                ) : (
                  <Sun size={14} aria-hidden="true" />
                )}
                <strong>{routine.label}</strong>
                <span>旧金山 {routine.localTime}</span>
              </span>
              <span className="last-reset-inline">
                <span>上次 Reset</span>
                {data.reset.event?.occurredAt ? (
                  <>
                    <strong>{daysSince(data.reset.event.occurredAt)} 天前</strong>
                    <time dateTime={data.reset.event.occurredAt}>
                      {dateTime(data.reset.event.occurredAt, timezone)}
                    </time>
                  </>
                ) : (
                  <strong>暂无已确认记录</strong>
                )}
              </span>
            </div>
          </div>
        </div>
        <div className="masthead-actions">
          <label className="timezone-control">
            <span>时区</span>
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
            aria-label="刷新雷达"
            title="刷新"
            disabled={refreshing}
          >
            {refreshing ? <LoaderCircle className="spin" size={18} /> : <RefreshCw size={18} />}
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => void share()}
            aria-label="分享预测"
            title="分享"
          >
            <Share2 size={18} />
          </button>
          <a
            className="icon-button"
            href="https://github.com/RZX00/tibo-reset-radar"
            target="_blank"
            rel="noreferrer"
            aria-label="查看 GitHub 仓库"
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

      {data.status.demoMode ? (
        <div className="demo-band">演示数据 · 真实 Tibo 身份与运行凭据尚未配置</div>
      ) : null}

      {/* ── 区域一：主结论 ── */}
      <section
        className="verdict-hero"
        data-level={verdict.level}
        aria-label="当前 Reset 可能性评估"
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
                当前公开状态：<strong>{activity.label}</strong>
              </span>
              <Info className="state-info-icon" size={13} aria-hidden="true" />
            </summary>
            <div className="state-explanation-panel">
              <strong>公开状态说明</strong>
              <ul>
                {(
                  Object.entries(activityMeta) as [
                    ActivityStatus,
                    (typeof activityMeta)[ActivityStatus],
                  ][]
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
        <section className="headline-probabilities" aria-label="核心预测概率">
          <figure
            aria-label={`未来 24 小时发生重置的概率 ${percent(forecast.cumulative.within24h)}`}
          >
            <span>未来 24 小时</span>
            <strong>{percent(forecast.cumulative.within24h)}</strong>
            <small>发生 Reset 的概率</small>
          </figure>
          <figure
            aria-label={`未来 48 小时发生重置的概率 ${percent(forecast.cumulative.within48h)}`}
          >
            <span>未来 48 小时</span>
            <strong>{percent(forecast.cumulative.within48h)}</strong>
            <small>发生 Reset 的概率</small>
          </figure>
          <figure aria-label={`未来 7 天发生重置的概率 ${percent(forecast.cumulative.within168h)}`}>
            <span>未来 7 天</span>
            <strong>{percent(forecast.cumulative.within168h)}</strong>
            <small>发生 Reset 的概率</small>
          </figure>
        </section>
      </section>

      {/* ── 区域三：天气式预测 ── */}
      <section className="weather-forecast" aria-labelledby="weather-heading">
        <div className="weather-heading">
          <div>
            <h2 id="weather-heading">未来 7 天</h2>
            <p>每一行表示下一次 Reset 落在该连续 24 小时窗口的概率。</p>
          </div>
          {peakDayIndex >= 0 ? (
            <p className="peak-day-note">
              最高窗口：第 {peakDayIndex + 1} 天 · {percent(peakDayProbability)}
            </p>
          ) : null}
        </div>

        {firstDay ? (
          <section className="today-forecast" aria-label="未来 24 小时分时预测">
            <div className="today-summary">
              <div>
                <span>未来 24 小时分时概率</span>
                <strong>{percent(forecast.cumulative.within24h)}</strong>
              </div>
              <p>四个连续 6 小时时间段</p>
            </div>
            <div className="hourly-strip">
              {firstDay.buckets.map((bucket) => (
                <article
                  className="hourly-window"
                  data-peak={bucket.intervalProbability === firstDayPeak}
                  key={bucket.index}
                  aria-label={`${clockTime(bucket.startAt, timezone)}–${clockTime(bucket.endAt, timezone)}，区间概率 ${precisePercent(bucket.intervalProbability)}`}
                >
                  <span className="hourly-range">
                    {clockTime(bucket.startAt, timezone)}–{clockTime(bucket.endAt, timezone)}
                  </span>
                  <strong>{precisePercent(bucket.intervalProbability)}</strong>
                  <small>{probabilityLabel(bucket.intervalProbability)}</small>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <ol className="daily-list" aria-label="未来七天区间概率">
          {forecast.days.map((item, index) => {
            return (
              <li
                className="daily-row"
                data-peak={index === peakDayIndex}
                key={item.dayIndex}
                aria-label={`第 ${item.dayIndex} 天，${timeRange(item.startAt, item.endAt, timezone)}，区间概率 ${percent(item.intervalProbability)}`}
              >
                <div className="daily-date">
                  <strong>{index === 0 ? "未来 24h" : weekday(item.startAt, timezone)}</strong>
                  <span>{shortDate(item.startAt, timezone)}</span>
                </div>
                <strong className="daily-probability">{percent(item.intervalProbability)}</strong>
                <div className="daily-signal">
                  <span>{probabilityLabel(item.intervalProbability)}</span>
                </div>
              </li>
            );
          })}
        </ol>
        <p className="window-disclaimer">
          当前 API 按连续 24
          小时切分；待新模型提供自然日口径后，这里将直接显示周三、周四等完整日概率。
        </p>
      </section>

      {/* ── 区域四：信号依据 ── */}
      <section className="signal-summary" aria-label="预测依据">
        <p className="signal-sentence">{signalSentence}</p>
        <button
          className="events-toggle"
          type="button"
          onClick={() => setEventsOpen((v) => !v)}
          aria-expanded={eventsOpen}
        >
          <span>
            <strong>查看近 24 小时原始推文</strong>
            <small>{data.events.items.length} 条公开动态</small>
          </span>
          <ChevronDown size={18} data-open={eventsOpen} />
        </button>
        <div className="events-collapse" data-open={eventsOpen}>
          {eventsOpen ? (
            <div>
              {data.events.items.length ? (
                data.events.items.map((event) => (
                  <EventRow key={event.postId} event={event} timezone={timezone} />
                ))
              ) : (
                <p className="empty-events">当前窗口没有新公开动态。</p>
              )}
            </div>
          ) : null}
        </div>
      </section>

      <footer className="footer-line">
        <div className="footer-notes">
          <p>{forecast.disclaimer}</p>
          <p className="data-footnote">
            <span className="status-dot" data-status={forecast.dataFreshness.status} />
            {freshnessLabel} · 更新于 {relativeTime(forecast.dataFreshness.lastObservedAt)} ·
            数据来自公开动态
          </p>
        </div>
        <span>Open-source experiment by ewo</span>
      </footer>
    </main>
  );
}
