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
  ExternalLink,
  Github,
  LoaderCircle,
  Radio,
  RefreshCw,
  Share2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { track } from "./analytics.js";
import { loadRadar, RadarApiError } from "./api.js";

type RadarData = Awaited<ReturnType<typeof loadRadar>>;

const TIMEZONES = ["Asia/Shanghai", "UTC", "America/Los_Angeles", "Europe/London"];

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

// 信号等级元数据（只在详细区用）
const signalMeta: Record<ForecastDay["signalLevel"], { label: string }> = {
  calm: { label: "信号平静" },
  slight: { label: "轻微信号" },
  gathering: { label: "信号聚集" },
  elevated: { label: "高概率窗口" },
  strong: { label: "强信号窗口" },
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

// 根据 topReasonCodes 生成一句自然语言信号依据
function buildSignalSentence(
  topReasons: [string, number][],
  activityStatus: ActivityStatus,
  eventCount: number,
): string {
  const hasSignal = topReasons.some(([r]) =>
    ["rules_future", "rules_rolling_out_now", "rules_completed", "rules_milestone", "rules_incident", "rules_incident_and_milestone"].includes(r),
  );
  if (hasSignal) {
    const labels = topReasons
      .filter(([r]) => r !== `${activityStatus}_activity`)
      .slice(0, 2)
      .map(([r]) => reasonLabel(r));
    return `检测到相关信号：${labels.join("、")}。参考了近 24 小时 ${eventCount} 条公开动态。`;
  }
  if (activityStatus === "active") return `Tibo 近期活跃，暂无明确 Reset 相关表述，当前依据历史周期估算。`;
  if (activityStatus === "cooling") return `Tibo 近期活动减少，暂无 Reset 信号，当前依据历史周期估算。`;
  return `Tibo 近期无新公开动态，当前完全依据历史基线估算，无可靠信号参考。`;
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
  const [selectedDay, setSelectedDay] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
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

  const allCalm = useMemo(() => {
    if (!forecast) return true;
    return forecast.days.every((d) => d.signalLevel === "calm");
  }, [forecast]);

  const topBucket = useMemo(() => {
    if (!forecast) return null;
    const allBuckets = forecast.days.flatMap((item) => item.buckets);
    if (allBuckets.length === 0) return null;
    return allBuckets.reduce((best, item) =>
      item.intervalProbability > best.intervalProbability ? item : best,
    );
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

  return (
    <main id="main-content" className="radar-shell">
      {/* ── 页头 ── */}
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
          <p className="verdict-headline">{verdict.headline}</p>
          <p className="verdict-sub">{verdict.sub}</p>
          {topBucket && topBucket.intervalProbability >= 0.01 ? (
            <p className="verdict-peak">
              预期时段：{timeRange(topBucket.startAt, topBucket.endAt, timezone)}
              {" "}·{" "}
              该窗口概率 {percent(topBucket.intervalProbability)}
            </p>
          ) : null}
        </div>
        <div className="verdict-number" aria-label={`未来48小时概率 ${percent(forecast.cumulative.within48h)}`}>
          <span>未来 48 小时</span>
          <strong>{percent(forecast.cumulative.within48h)}</strong>
          <small>7 天 {percent(forecast.cumulative.within168h)}</small>
        </div>
      </section>

      {/* ── 区域二：背景参考 ── */}
      <section className="context-bar" aria-label="背景参考信息">
        <div className="context-item">
          <span>上次 Reset</span>
          {data.reset.event?.occurredAt ? (
            <>
              <strong>{daysSince(data.reset.event.occurredAt)} 天前</strong>
              <p>{dateTime(data.reset.event.occurredAt, timezone)}</p>
            </>
          ) : (
            <>
              <strong>暂无记录</strong>
              <p>尚无已确认的 Reset 历史</p>
            </>
          )}
        </div>
        <div className="context-item">
          <span>Tibo 公开活动</span>
          <strong data-status={data.status.activity.status}>{activity.label}</strong>
          <p>{activity.note} · {relativeTime(data.status.activity.lastPublicActivityAt)}</p>
        </div>
        <div className="context-item">
          <span>未来 48 小时</span>
          <strong>{percent(forecast.cumulative.within48h)}</strong>
          <p>72 小时 {percent(forecast.cumulative.within72h)}</p>
        </div>
        <div className="context-item">
          <span>数据状态</span>
          <strong>
            <span className="status-dot" data-status={forecast.dataFreshness.status} />
            {forecast.dataFreshness.status === "fresh"
              ? "正常"
              : forecast.dataFreshness.status === "delayed"
                ? "延迟"
                : "陈旧"}
          </strong>
          <p>更新于 {relativeTime(forecast.dataFreshness.lastObservedAt)}</p>
        </div>
      </section>

      {/* ── 区域三：信号依据 ── */}
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

      {/* ── 区域四：详细预测数据（折叠） ── */}
      <section className="detail-collapse-section">
        <button
          className="detail-toggle"
          type="button"
          onClick={() => setDetailOpen((v) => !v)}
          aria-expanded={detailOpen}
        >
          <span>查看 7 天详细预测数据</span>
          <ChevronDown size={18} data-open={detailOpen} />
        </button>

        {detailOpen ? (
          <div className="detail-inner">
            {/* 7天卡片 */}
            <div className="forecast-section" aria-labelledby="forecast-heading">
              <div className="section-heading">
                <div>
                  <span>7 DAY SIGNAL STRIP</span>
                  <h2 id="forecast-heading">未来窗口</h2>
                </div>
              </div>
              <div className="forecast-strip">
                {forecast.days.map((item, index) => {
                  const meta = signalMeta[item.signalLevel];
                  const range = timeRange(item.startAt, item.endAt, timezone);
                  return (
                    <button
                      key={item.dayIndex}
                      type="button"
                      className="day-card"
                      data-selected={index === selectedDay}
                      onClick={() => setSelectedDay(index)}
                      aria-pressed={index === selectedDay}
                      aria-label={`DAY ${item.dayIndex} ${range} 区间概率 ${percent(item.intervalProbability)}`}
                    >
                      <span className="day-index">DAY {item.dayIndex}</span>
                      <span className="day-window">{dateTime(item.startAt, timezone)} 起</span>
                      <div className="day-bar">
                        <span style={{ width: `${Math.round(item.intervalProbability * 100)}%` }} />
                      </div>
                      <strong>{percent(item.intervalProbability)}</strong>
                      <span className="signal-label">{meta.label}</span>
                      <span className="cumulative">累计 {percent(item.cumulativeProbability)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 6小时桶 */}
            <div className="detail-section">
              <div className="detail-heading">
                <div>
                  <span>DAY {day.dayIndex} · 6H WINDOWS</span>
                  <h2>{timeRange(day.startAt, day.endAt, timezone)}</h2>
                </div>
                <p>{signalMeta[day.signalLevel].label} · 每格是该 6 小时区间内发生的概率</p>
              </div>
              <div className="bucket-grid">
                {day.buckets.map((bucket) => (
                  <div className="bucket" key={bucket.index}>
                    <span>{timeRange(bucket.startAt, bucket.endAt, timezone)}</span>
                    <strong>{percent(bucket.intervalProbability)}</strong>
                    <div
                      className="probability-track"
                      role="progressbar"
                      aria-label={`${timeRange(bucket.startAt, bucket.endAt, timezone)} 区间概率`}
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
            </div>

            {/* 累计概率 */}
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

            {/* 信号列表 */}
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
          </div>
        ) : null}
      </section>

      <footer className="footer-line">
        <p>{forecast.disclaimer}</p>
        <span>Open-source experiment by ewo</span>
      </footer>
    </main>
  );
}
