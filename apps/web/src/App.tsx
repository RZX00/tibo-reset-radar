import type {
  ActivityStatus,
  ForecastDay,
  ForecastSnapshot,
  SourcePostObserved,
} from "@tibo-radar/contracts";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Cloud,
  CloudLightning,
  CloudRain,
  CloudSun,
  ExternalLink,
  Github,
  LoaderCircle,
  Radio,
  RefreshCw,
  Share2,
  Sun,
} from "lucide-react";
import { type ComponentType, useCallback, useEffect, useMemo, useState } from "react";
import { track } from "./analytics.js";
import { loadRadar, RadarApiError } from "./api.js";

type RadarData = Awaited<ReturnType<typeof loadRadar>>;

const TIMEZONES = ["Asia/Shanghai", "UTC", "America/Los_Angeles", "Europe/London"];

const weatherMeta: Record<
  ForecastDay["weatherCode"],
  { label: string; note: string; icon: ComponentType<{ size?: number; strokeWidth?: number }> }
> = {
  clear: { label: "晴", note: "信号平静", icon: Sun },
  partly_cloudy: { label: "晴间多云", note: "轻微信号", icon: CloudSun },
  cloudy: { label: "多云", note: "信号聚集", icon: Cloud },
  storm_watch: { label: "雷雨观察", note: "高概率窗口", icon: CloudRain },
  storm_warning: { label: "暴雨预警", note: "强信号窗口", icon: CloudLightning },
};

const activityMeta: Record<ActivityStatus, { label: string; note: string }> = {
  active: { label: "活跃", note: "30 分钟内有公开活动" },
  cooling: { label: "降温", note: "公开活动正在减少" },
  quiet: { label: "安静", note: "近期没有新公开动态" },
  data_delayed: { label: "数据延迟", note: "采集暂时无法确认" },
};

const reasonLabels: Record<string, string> = {
  recent_activity: "近期活动",
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

const skeletonKeys = ["day-1", "day-2", "day-3", "day-4", "day-5", "day-6", "day-7"];

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
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

function DayCard({
  day,
  timezone,
  selected,
  onSelect,
}: {
  day: ForecastDay;
  timezone: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = weatherMeta[day.weatherCode];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      className="day-card"
      data-selected={selected}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="day-index">DAY {day.dayIndex}</span>
      <span className="day-window">{dateTime(day.startAt, timezone)}</span>
      <Icon size={32} strokeWidth={1.6} />
      <strong>{percent(day.intervalProbability)}</strong>
      <span className="weather-label">{meta.label}</span>
      <span className="weather-note">{meta.note}</span>
      <span className="cumulative">累计 {percent(day.cumulativeProbability)}</span>
    </button>
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
  const [selectedDay, setSelectedDay] = useState(0);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [shareFeedback, setShareFeedback] = useState<string | null>(null);

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

  const forecast: ForecastSnapshot | null = data?.forecast ?? null;
  const day = forecast?.days[selectedDay] ?? forecast?.days[0] ?? null;
  const topBucket = useMemo(() => {
    if (!forecast) return null;
    return forecast.days
      .flatMap((item) => item.buckets)
      .reduce((best, item) => (item.intervalProbability > best.intervalProbability ? item : best));
  }, [forecast]);
  const topReasons = useMemo(() => {
    if (!forecast) return [];
    const counts = new Map<string, number>();
    for (const reason of forecast.days
      .flatMap((item) => item.buckets)
      .flatMap((item) => item.topReasonCodes)) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 4);
  }, [forecast]);

  async function share() {
    if (!forecast) return;
    setShareFeedback(null);
    const payload = {
      title: "Tibo Reset Radar",
      text: `未来 7 天累计 Reset 概率 ${percent(forecast.cumulative.within168h)}`,
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
  if (!data || !forecast || !day) return null;

  const activity = activityMeta[data.status.activity.status];
  const resetState = data.reset.state;

  return (
    <main id="main-content" className="radar-shell">
      <header className="masthead">
        <div>
          <span className="edition">
            {data.status.demoMode ? "DEMO DATA · " : ""}PUBLIC SIGNAL DESK · 168H OUTLOOK
          </span>
          <h1>Tibo Reset Radar</h1>
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

      {resetState !== "forecasting" ? (
        <section className="confirmation-band" data-state={resetState} aria-live="polite">
          {resetState === "confirmed_reset" ? (
            <CheckCircle2 size={22} />
          ) : (
            <AlertTriangle size={22} />
          )}
          <strong>
            {resetState === "confirmed_reset"
              ? "Reset 已确认"
              : resetState === "candidate_confirmation"
                ? "发现待确认信号"
                : "确认信号已撤回"}
          </strong>
          <span>
            {resetState === "confirmed_reset"
              ? "权威公开证据已经出现；实际账户到达时间可能不同。"
              : resetState === "candidate_confirmation"
                ? "系统正在保守核对权威来源与已发生语义。"
                : "此前确认不再有效，预测恢复为启发式状态。"}
          </span>
        </section>
      ) : null}

      <section className="now-band">
        <div className="activity-reading" data-status={data.status.activity.status}>
          <Activity size={19} />
          <div>
            <span>公开活动</span>
            <strong>{activity.label}</strong>
          </div>
          <p>
            {activity.note} · {relativeTime(data.status.activity.lastPublicActivityAt)}
          </p>
        </div>
        <div className="headline-reading">
          <span>未来 48 小时</span>
          <strong>{percent(forecast.cumulative.within48h)}</strong>
          <p>7 天累计 {percent(forecast.cumulative.within168h)}</p>
        </div>
        <div className="freshness-reading">
          <span className="status-dot" data-status={forecast.dataFreshness.status} />
          <div>
            <span>
              数据
              {forecast.dataFreshness.status === "fresh"
                ? "正常"
                : forecast.dataFreshness.status === "delayed"
                  ? "延迟"
                  : "陈旧"}
            </span>
            <strong>{relativeTime(forecast.dataFreshness.lastObservedAt)}</strong>
          </div>
          <p>模型 {forecast.model.version}</p>
        </div>
      </section>

      <section className="cumulative-band" aria-label="累计概率">
        {(
          [
            ["24 小时", forecast.cumulative.within24h],
            ["48 小时", forecast.cumulative.within48h],
            ["72 小时", forecast.cumulative.within72h],
            ["168 小时", forecast.cumulative.within168h],
          ] as const
        ).map(([label, probability]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{percent(probability)}</strong>
          </div>
        ))}
      </section>

      <section className="forecast-section" aria-labelledby="forecast-heading">
        <div className="section-heading">
          <div>
            <span>7 DAY WEATHER STRIP</span>
            <h2 id="forecast-heading">未来窗口</h2>
          </div>
          {topBucket ? (
            <p>
              峰值时段 {dateTime(topBucket.startAt, timezone)} ·{" "}
              {percent(topBucket.intervalProbability)}
            </p>
          ) : null}
        </div>
        <div className="forecast-strip">
          {forecast.days.map((item, index) => (
            <DayCard
              key={item.dayIndex}
              day={item}
              timezone={timezone}
              selected={index === selectedDay}
              onSelect={() => setSelectedDay(index)}
            />
          ))}
        </div>
      </section>

      <section className="detail-section">
        <div className="detail-heading">
          <div>
            <span>DAY {day.dayIndex} · 6H WINDOWS</span>
            <h2>{dateTime(day.startAt, timezone)} 起</h2>
          </div>
          <p>{weatherMeta[day.weatherCode].note}</p>
        </div>
        <div className="bucket-grid">
          {day.buckets.map((bucket) => (
            <div className="bucket" key={bucket.index}>
              <span>{dateTime(bucket.startAt, timezone)}</span>
              <strong>{percent(bucket.intervalProbability)}</strong>
              <div
                className="probability-track"
                role="progressbar"
                aria-label="时段概率"
                aria-valuemin={0}
                aria-valuemax={99}
                aria-valuenow={Math.round(bucket.intervalProbability * 100)}
              >
                <span style={{ transform: `scaleX(${bucket.intervalProbability})` }} />
              </div>
              <p>{bucket.topReasonCodes.slice(0, 2).map(reasonLabel).join(" · ") || "历史基线"}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="signals-section" aria-labelledby="signals-heading">
        <div>
          <span>主要信号</span>
          <h2 id="signals-heading">本轮预测依据</h2>
        </div>
        <div className="signal-list">
          {topReasons.map(([reason, count]) => (
            <div key={reason}>
              <strong>{reasonLabel(reason)}</strong>
              <span>{count} 个时段</span>
            </div>
          ))}
        </div>
      </section>

      <section className="events-section">
        <button
          className="events-toggle"
          type="button"
          onClick={() => setEventsOpen((value) => !value)}
          aria-expanded={eventsOpen}
        >
          <span>
            <strong>最近 24 小时</strong>
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
        <p>{forecast.disclaimer}</p>
        <span>Open-source experiment by ewo</span>
      </footer>
    </main>
  );
}
