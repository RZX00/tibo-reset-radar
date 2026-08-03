export interface BacktestCase {
  predictedProbability: number;
  outcome: 0 | 1;
}

export interface CalibrationBin {
  lowerBound: number;
  upperBound: number;
  sampleSize: number;
  meanPrediction: number | null;
  observedRate: number | null;
}

export interface BacktestReport {
  sampleSize: number;
  brierScore: number | null;
  logLoss: number | null;
  calibration: CalibrationBin[];
}

export function evaluateBacktest(cases: readonly BacktestCase[]): BacktestReport {
  const normalized = cases.map((item) => {
    if (item.predictedProbability < 0 || item.predictedProbability > 0.99) {
      throw new Error("Backtest probability must be between 0 and 0.99");
    }
    return item;
  });
  const calibration = Array.from({ length: 10 }, (_, index) => {
    const lowerBound = index / 10;
    const upperBound = (index + 1) / 10;
    const members = normalized.filter(({ predictedProbability }) =>
      index === 9
        ? predictedProbability >= lowerBound && predictedProbability <= 0.99
        : predictedProbability >= lowerBound && predictedProbability < upperBound,
    );
    return {
      lowerBound,
      upperBound,
      sampleSize: members.length,
      meanPrediction: members.length
        ? members.reduce((sum, item) => sum + item.predictedProbability, 0) / members.length
        : null,
      observedRate: members.length
        ? members.reduce((sum, item) => sum + item.outcome, 0) / members.length
        : null,
    };
  });

  if (normalized.length === 0) {
    return { sampleSize: 0, brierScore: null, logLoss: null, calibration };
  }

  const epsilon = 1e-12;
  const brierScore =
    normalized.reduce((sum, item) => sum + (item.predictedProbability - item.outcome) ** 2, 0) /
    normalized.length;
  const logLoss =
    -normalized.reduce((sum, item) => {
      const probability = Math.min(1 - epsilon, Math.max(epsilon, item.predictedProbability));
      return (
        sum + item.outcome * Math.log(probability) + (1 - item.outcome) * Math.log(1 - probability)
      );
    }, 0) / normalized.length;

  return { sampleSize: normalized.length, brierScore, logLoss, calibration };
}
