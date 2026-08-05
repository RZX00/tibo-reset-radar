/**
 * The page is read by two audiences that do not overlap much: the Chinese Codex community that
 * follows the reset folklore, and the English-speaking readers who find it from X. Both get the
 * same numbers; only the words change. Every visible string lives here so a missing translation is
 * a type error rather than a Chinese sentence on an English page.
 */
export type Lang = "zh" | "en";

export const LANGS: readonly Lang[] = ["zh", "en"];

export interface Strings {
  langName: string;
  langLabel: string;
  edition: { demo: string; outlook: string };
  avatarAlt: string;
  routineTitle: string;
  routine: {
    awakeRecent: string;
    sleeping: string;
    social: string;
    windingDown: string;
    awake: string;
    localTime: (time: string) => string;
  };
  lastReset: { label: string; daysAgo: (days: number) => string; none: string };
  actions: {
    timezone: string;
    refresh: string;
    refreshTitle: string;
    share: string;
    shareTitle: string;
    github: string;
  };
  shareFeedback: { shared: string; copied: string; cancelled: string; failed: string };
  shareText: (within24h: string, within48h: string, within168h: string) => string;
  demoBand: string;
  verdictAria: string;
  currentState: (label: string) => string;
  stateExplainer: string;
  verdict: {
    confirmed: { headline: string; sub: string };
    candidate: { headline: string; sub: string };
    high24: { headline: string; sub: (value: string) => string };
    high48: { headline: string; sub: (value: string) => string };
    medium: { headline: string; sub: (value: string) => string };
    low: { headline: string; sub: (within48h: string, within168h: string) => string };
    none: { headlineCalm: string; headline: string; sub: (value: string) => string };
  };
  activity: Record<
    "active" | "cooling" | "quiet" | "data_delayed",
    { label: string; note: string }
  >;
  sleep: { label: string; note: (sampleSize: number) => string; noteFallback: string };
  headline: {
    aria: string;
    within24h: string;
    within48h: string;
    within168h: string;
    caption: string;
    figureAria: (window: string, value: string) => string;
  };
  weather: {
    heading: string;
    note: string;
    peak: (day: number, value: string) => string;
    todayAria: string;
    todaySummary: string;
    todayBuckets: string;
    bucketAria: (range: string, value: string) => string;
    dailyAria: string;
    dayAria: (day: number, range: string, value: string) => string;
    firstDay: string;
    disclaimer: string;
  };
  probability: { high: string; medium: string; low: string; veryLow: string };
  signals: {
    aria: string;
    detected: (labels: string, eventCount: number) => string;
    active: string;
    cooling: string;
    quiet: string;
    toggle: string;
    count: (count: number) => string;
    empty: string;
  };
  events: { reply: string; quote: string; post: string; openOnX: string; openTitle: string };
  freshness: { fresh: string; delayed: string; stale: string };
  footer: {
    updated: (relative: string) => string;
    source: string;
    disclaimer: string;
    /** The credit reads "<prefix> [ewo] <suffix>", because Chinese puts the verb after the name. */
    poweredPrefix: string;
    poweredSuffix: string;
    brandLink: string;
  };
  relative: {
    none: string;
    seconds: (n: number) => string;
    minutes: (n: number) => string;
    hours: (n: number) => string;
  };
  error: { title: string; retry: string; offline: string };
  reasons: Record<string, string>;
  reasonFallback: string;
}

const zhReasons: Record<string, string> = {
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

const enReasons: Record<string, string> = {
  recent_activity: "Recent activity",
  cadence_0_24h: "Cooldown, under 24h since the last reset",
  cadence_24_48h: "1–2 days since the last reset",
  cadence_48_72h: "2–3 days since the last reset",
  cadence_3_4d: "Approaching the average reset gap",
  cadence_4_7d: "Past the average reset gap",
  cadence_7d_plus: "More than 7 days since the last reset",
  post_activity_high: "Posting more than usual",
  post_activity_normal: "Posting about as usual",
  post_activity_low: "Posting less than usual",
  post_activity_baseline_unavailable: "Not enough posting history to adjust",
  circadian_sleep: "Usual sleeping hours",
  circadian_awake: "Usual waking hours",
  circadian_social: "Usual evening activity",
  circadian_winding_down: "Usually winding down",
  active_activity: "Recent public activity",
  cooling_activity: "Activity cooling off",
  quiet_activity: "Low activity baseline",
  data_delayed_activity: "Data delayed",
  rules_none: "No explicit reset signal",
  rules_future: "Promised a future reset",
  rules_rolling_out_now: "Reset rolling out",
  rules_completed: "Reset completed wording",
  rules_limited: "Limited-scope reset",
  rules_retracted: "Reset retracted",
  rules_ambiguous: "Ambiguous reset wording",
  rules_reset_mention: "Mentions a reset",
  rules_milestone: "Milestone progress",
  rules_incident: "Incident signal",
  rules_incident_and_milestone: "Incident and milestone signals",
  source_not_authoritative: "Source is not authoritative",
  source_not_first_party_statement: "Not a first-party statement",
  banked_reset_ignored: "Banked reset ignored",
  banked_reset_forecast_only: "Banked reset counts only toward the forecast",
  authoritative_retraction: "Authoritative retraction",
  retraction_requires_deterministic_evidence: "Retraction still needs confirmation",
  no_completed_reset_claim: "No completed-reset claim",
  future_or_uncertain_language: "Future or uncertain wording",
  completion_requires_deterministic_evidence: "Completion still needs confirmation",
  authoritative_completed_reset: "Authoritative completion",
};

const zh: Strings = {
  langName: "中文",
  langLabel: "语言",
  edition: { demo: "DEMO DATA · ", outlook: "NEXT RESET OUTLOOK" },
  avatarAlt: "Tibo 头像",
  routineTitle: "根据 Tibo 的常规作息推测；近期公开活动优先",
  routine: {
    awakeRecent: "醒着 · 刚刚有公开活动",
    sleeping: "大概率睡觉",
    social: "通常在刷推",
    windingDown: "可能准备休息",
    awake: "大概率醒着",
    localTime: (time) => `旧金山 ${time}`,
  },
  lastReset: {
    label: "上次 Reset",
    daysAgo: (days) => `${days} 天前`,
    none: "暂无已确认记录",
  },
  actions: {
    timezone: "时区",
    refresh: "刷新雷达",
    refreshTitle: "刷新",
    share: "分享预测",
    shareTitle: "分享",
    github: "查看 GitHub 仓库",
  },
  shareFeedback: {
    shared: "分享成功",
    copied: "链接已复制",
    cancelled: "已取消分享",
    failed: "分享失败，请稍后重试",
  },
  shareText: (within24h, within48h, within168h) =>
    `未来 24 小时 Reset 概率 ${within24h}，未来 48 小时 ${within48h}，未来 7 天 ${within168h}`,
  demoBand: "演示数据 · 真实 Tibo 身份与运行凭据尚未配置",
  verdictAria: "当前 Reset 可能性评估",
  currentState: (label) => `当前公开状态：${label}`,
  stateExplainer: "公开状态说明",
  verdict: {
    confirmed: {
      headline: "Reset 已确认",
      sub: "权威来源已宣布，账户配额即将恢复。实际到账时间因账户而异。",
    },
    candidate: {
      headline: "发现候选信号，正在核实",
      sub: "系统检测到疑似确认信号，正在保守核对权威来源，请稍后刷新。",
    },
    high24: {
      headline: "今天可能性较高，建议持续关注",
      sub: (value) => `未来 24 小时累计概率 ${value}，信号较强，推荐今天保持关注。`,
    },
    high48: {
      headline: "近两天可能性较高，建议留意",
      sub: (value) => `未来 48 小时累计概率 ${value}，信号有所增强，建议今明两天关注。`,
    },
    medium: {
      headline: "近两天有一定可能性",
      sub: (value) => `未来 48 小时累计概率 ${value}，存在一定信号，建议偶尔查看。`,
    },
    low: {
      headline: "信号较弱，本周可能性低",
      sub: (within48h, within168h) =>
        `未来 48 小时 ${within48h}，7 天累计 ${within168h}，当前无明确信号。`,
    },
    none: {
      headlineCalm: "暂无信号，无需特别关注",
      headline: "信号平静，持续监测中",
      sub: (value) => `未来 48 小时概率 ${value}，依据历史基线估算，近期无异常信号。`,
    },
  },
  activity: {
    active: { label: "活跃", note: "30 分钟内有公开活动" },
    cooling: { label: "降温", note: "公开活动正在减少" },
    quiet: { label: "安静", note: "近期没有新公开动态" },
    data_delayed: { label: "数据延迟", note: "采集暂时无法确认" },
  },
  sleep: {
    label: "可能在睡觉",
    note: (sampleSize) => `按近 30 天 ${sampleSize} 条公开动态推测，当前处于低活跃时段`,
    noteFallback: "按历史公开活动时段推测，当前可能正在休息",
  },
  headline: {
    aria: "核心预测概率",
    within24h: "未来 24 小时",
    within48h: "未来 48 小时",
    within168h: "未来 7 天",
    caption: "发生 Reset 的概率",
    figureAria: (window, value) => `${window}发生重置的概率 ${value}`,
  },
  weather: {
    heading: "未来 7 天",
    note: "每一行表示下一次 Reset 落在该连续 24 小时窗口的概率。",
    peak: (day, value) => `最高窗口：第 ${day} 天 · ${value}`,
    todayAria: "未来 24 小时分时预测",
    todaySummary: "未来 24 小时分时概率",
    todayBuckets: "四个连续 6 小时时间段",
    bucketAria: (range, value) => `${range}，区间概率 ${value}`,
    dailyAria: "未来七天区间概率",
    dayAria: (day, range, value) => `第 ${day} 天，${range}，区间概率 ${value}`,
    firstDay: "未来 24h",
    disclaimer:
      "当前 API 按连续 24 小时切分；待新模型提供自然日口径后，这里将直接显示周三、周四等完整日概率。",
  },
  probability: { high: "较高", medium: "中等", low: "较低", veryLow: "很低" },
  signals: {
    aria: "预测依据",
    detected: (labels, eventCount) =>
      `检测到相关信号：${labels}。参考了近 24 小时 ${eventCount} 条公开动态。`,
    active: "Tibo 近期活跃，暂无明确 Reset 相关表述，当前依据历史周期估算。",
    cooling: "Tibo 近期活动减少，暂无 Reset 信号，当前依据历史周期估算。",
    quiet: "Tibo 近期无新公开动态，当前完全依据历史基线估算，无可靠信号参考。",
    toggle: "查看近 24 小时原始推文",
    count: (count) => `${count} 条公开动态`,
    empty: "当前窗口没有新公开动态。",
  },
  events: {
    reply: "回复",
    quote: "引用",
    post: "帖子",
    openOnX: "在 X 查看原帖",
    openTitle: "在 X 查看",
  },
  freshness: { fresh: "数据正常", delayed: "数据延迟", stale: "数据陈旧" },
  footer: {
    updated: (relative) => `更新于 ${relative}`,
    source: "数据来自公开动态",
    disclaimer: "启发式预测不代表 Reset 已确认；模型概率最高为 99%。",
    poweredPrefix: "本项目由",
    poweredSuffix: "提供支持",
    brandLink: "访问 ewo API",
  },
  relative: {
    none: "暂无",
    seconds: (n) => `${n} 秒前`,
    minutes: (n) => `${n} 分钟前`,
    hours: (n) => `${n} 小时前`,
  },
  error: {
    title: "雷达暂时离线",
    retry: "重新连接",
    offline: "无法连接到 Radar API。请检查服务后重试。",
  },
  reasons: zhReasons,
  reasonFallback: "其他信号",
};

const en: Strings = {
  langName: "English",
  langLabel: "Language",
  edition: { demo: "DEMO DATA · ", outlook: "NEXT RESET OUTLOOK" },
  avatarAlt: "Tibo avatar",
  routineTitle: "Inferred from Tibo's usual hours; recent public activity wins",
  routine: {
    awakeRecent: "Awake · posted just now",
    sleeping: "Likely asleep",
    social: "Usually scrolling",
    windingDown: "Likely winding down",
    awake: "Likely awake",
    localTime: (time) => `San Francisco ${time}`,
  },
  lastReset: {
    label: "Last reset",
    daysAgo: (days) => `${days}d ago`,
    none: "No confirmed reset yet",
  },
  actions: {
    timezone: "Timezone",
    refresh: "Refresh the radar",
    refreshTitle: "Refresh",
    share: "Share the forecast",
    shareTitle: "Share",
    github: "Open the GitHub repository",
  },
  shareFeedback: {
    shared: "Shared",
    copied: "Link copied",
    cancelled: "Sharing cancelled",
    failed: "Sharing failed, try again later",
  },
  shareText: (within24h, within48h, within168h) =>
    `Reset probability: ${within24h} within 24h, ${within48h} within 48h, ${within168h} within 7 days`,
  demoBand: "Demo data · the real target identity and credentials are not configured",
  verdictAria: "Current reset outlook",
  currentState: (label) => `Public state: ${label}`,
  stateExplainer: "What the public states mean",
  verdict: {
    confirmed: {
      headline: "Reset confirmed",
      sub: "An authoritative source announced it. When it lands on a given account still varies.",
    },
    candidate: {
      headline: "Candidate signal, verifying",
      sub: "Something looks like a confirmation. It is being checked against authoritative sources.",
    },
    high24: {
      headline: "Fairly likely today — worth watching",
      sub: (value) =>
        `${value} within the next 24 hours. The signal is strong enough to watch today.`,
    },
    high48: {
      headline: "Fairly likely in the next two days",
      sub: (value) => `${value} within the next 48 hours. The signal has picked up.`,
    },
    medium: {
      headline: "Some chance in the next two days",
      sub: (value) => `${value} within the next 48 hours. Worth an occasional look.`,
    },
    low: {
      headline: "Weak signal, unlikely this week",
      sub: (within48h, within168h) =>
        `${within48h} within 48 hours and ${within168h} within 7 days. Nothing explicit right now.`,
    },
    none: {
      headlineCalm: "No signal — nothing to watch for",
      headline: "Quiet, still monitoring",
      sub: (value) => `${value} within 48 hours, estimated from the historical baseline.`,
    },
  },
  activity: {
    active: { label: "Active", note: "Public activity within 30 minutes" },
    cooling: { label: "Cooling", note: "Public activity is slowing down" },
    quiet: { label: "Quiet", note: "No recent public activity" },
    data_delayed: { label: "Data delayed", note: "Collection cannot confirm right now" },
  },
  sleep: {
    label: "Likely asleep",
    note: (sampleSize) =>
      `Inferred from ${sampleSize} public posts over 30 days; this is his quietest window`,
    noteFallback: "Inferred from past posting hours; this is usually a quiet window",
  },
  headline: {
    aria: "Headline probabilities",
    within24h: "Next 24 hours",
    within48h: "Next 48 hours",
    within168h: "Next 7 days",
    caption: "chance of a reset",
    figureAria: (window, value) => `${window}: ${value} chance of a reset`,
  },
  weather: {
    heading: "Next 7 days",
    note: "Each row is the chance the next reset falls inside that rolling 24-hour window.",
    peak: (day, value) => `Peak window: day ${day} · ${value}`,
    todayAria: "Next 24 hours by window",
    todaySummary: "Next 24 hours by window",
    todayBuckets: "Four rolling six-hour windows",
    bucketAria: (range, value) => `${range}, ${value} for the interval`,
    dailyAria: "Seven-day interval probabilities",
    dayAria: (day, range, value) => `Day ${day}, ${range}, ${value} for the interval`,
    firstDay: "Next 24h",
    disclaimer:
      "The API currently splits rolling 24-hour windows; calendar-day probabilities arrive with the next model.",
  },
  probability: { high: "High", medium: "Medium", low: "Low", veryLow: "Very low" },
  signals: {
    aria: "Forecast basis",
    detected: (labels, eventCount) =>
      `Signals detected: ${labels}. Based on ${eventCount} public posts in the last 24 hours.`,
    active:
      "Tibo is posting, with nothing explicit about a reset. Estimated from the usual cadence.",
    cooling: "Tibo is posting less, with no reset signal. Estimated from the usual cadence.",
    quiet: "No new public posts, so this is the historical baseline with no signal to lean on.",
    toggle: "Show the raw posts from the last 24 hours",
    count: (count) => `${count} public posts`,
    empty: "No new public posts in this window.",
  },
  events: {
    reply: "Reply",
    quote: "Quote",
    post: "Post",
    openOnX: "Open the original post on X",
    openTitle: "Open on X",
  },
  freshness: { fresh: "Data healthy", delayed: "Data delayed", stale: "Data stale" },
  footer: {
    updated: (relative) => `updated ${relative}`,
    source: "built from public posts",
    disclaimer: "A heuristic forecast is not a confirmed reset; the model never exceeds 99%.",
    poweredPrefix: "This project is powered by",
    poweredSuffix: "",
    brandLink: "Visit ewo API",
  },
  relative: {
    none: "never",
    seconds: (n) => `${n}s ago`,
    minutes: (n) => `${n}m ago`,
    hours: (n) => `${n}h ago`,
  },
  error: {
    title: "Radar is offline",
    retry: "Reconnect",
    offline: "Could not reach the radar API. Check the service and try again.",
  },
  reasons: enReasons,
  reasonFallback: "Other signal",
};

export const dictionaries: Record<Lang, Strings> = { zh, en };

const STORAGE_KEY = "radar-lang";

export function detectLang(): Lang {
  if (typeof window !== "undefined") {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    if (stored === "zh" || stored === "en") return stored;
    // Chinese readers arrive from the reset folklore; everyone else reads the English page.
    const preferred = window.navigator?.languages?.[0] ?? window.navigator?.language ?? "";
    return preferred.toLowerCase().startsWith("zh") ? "zh" : "en";
  }
  return "zh";
}

export function rememberLang(lang: Lang): void {
  if (typeof window !== "undefined") window.localStorage?.setItem(STORAGE_KEY, lang);
}

/** The locale that formats dates and weekdays for a language. */
export function localeFor(lang: Lang): string {
  return lang === "zh" ? "zh-CN" : "en-GB";
}
