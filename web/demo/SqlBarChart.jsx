import React from "react";

const formatNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });

function shortLabel(value) {
  return value.length > 13 ? `${value.slice(0, 12)}…` : value;
}

const SERIES_COLORS = ["#166534", "#0f766e", "#b45309", "#6d28d9", "#be123c", "#0369a1", "#4d7c0f", "#a16207", "#7c3aed", "#be185d"];

function StackedSqlBarChart({ bars, xLabel, yLabel, showValues, series, seriesLabel }) {
  const width = Math.max(720, bars.length * 58 + 76);
  const height = 310;
  const pad = { left: 64, right: 20, top: 38, bottom: 58 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const minimum = Math.min(0, ...bars.map((bar) => bar.negative));
  const maximum = Math.max(0, ...bars.map((bar) => bar.positive));
  const high = maximum === minimum ? 1 : maximum;
  const yFor = (value) => pad.top + ((high - value) / (high - minimum)) * plotHeight;
  const ticks = [minimum, 0, high].filter((value, index, values) => values.indexOf(value) === index);
  const step = plotWidth / bars.length;
  const barWidth = Math.max(8, step - 14);
  const colors = new Map(series.map((name, index) => [name, SERIES_COLORS[index % SERIES_COLORS.length]]));

  return <div className="border border-stone-300 bg-white px-2 py-3" role="img" aria-label={`Stacked bar chart: ${xLabel} on the X-axis, ${yLabel} on the Y-axis, stacked by ${seriesLabel}; ${bars.length} bars and ${series.length} categories`}>
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="bar-chart max-w-none" aria-hidden="true">
        {ticks.map((tick) => <g key={tick}>
          <line x1={pad.left} x2={width - pad.right} y1={yFor(tick)} y2={yFor(tick)} stroke="#d6d3d1" strokeWidth="1" />
          <text x={pad.left - 9} y={yFor(tick) + 4} textAnchor="end" fill="#78716c" fontSize="11">{formatNumber.format(tick)}</text>
        </g>)}
        {bars.map((bar, index) => {
          const x = pad.left + index * step + (step - barWidth) / 2;
          let positive = 0;
          let negative = 0;
          return <g key={index}>
            {bar.segments.map((segment) => {
              const start = segment.value >= 0 ? positive : negative;
              const end = start + segment.value;
              if (segment.value >= 0) positive = end;
              else negative = end;
              const top = yFor(Math.max(start, end));
              const segmentHeight = Math.abs(yFor(start) - yFor(end));
              return <g key={segment.series}>
                <rect className="stacked-segment" data-series={segment.series} x={x} y={top} width={barWidth} height={segmentHeight} fill={colors.get(segment.series)}>
                  <title>{bar.label} · {segment.series}: {formatNumber.format(segment.value)}</title>
                </rect>
                {showValues && segmentHeight >= 17 && barWidth >= 30 && <text x={x + barWidth / 2} y={top + segmentHeight / 2 + 3} textAnchor="middle" fill="#fff" fontSize="10">{formatNumber.format(segment.value)}</text>}
              </g>;
            })}
            {showValues && <text x={x + barWidth / 2} y={bar.positive > 0 ? Math.max(14, yFor(bar.positive) - 7) : Math.min(height - pad.bottom - 3, yFor(bar.negative) + 14)} textAnchor="middle" fill="#57534e" fontSize="10">{formatNumber.format(bar.total)}</text>}
            <text x={x + barWidth / 2} y={height - 32} textAnchor="middle" fill="#57534e" fontSize="11"><title>{bar.label}</title>{shortLabel(bar.label)}</text>
          </g>;
        })}
        <text x={pad.left + plotWidth / 2} y={height - 8} textAnchor="middle" fill="#57534e" fontSize="11">{xLabel}</text>
      </svg>
    </div>
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 px-2 text-xs text-stone-700" aria-label={`${seriesLabel} categories`}>
      {series.map((name) => <span key={name} className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 shrink-0" style={{ backgroundColor: colors.get(name) }} />{name}</span>)}
    </div>
  </div>;
}

export default function SqlBarChart({ bars, xLabel, yLabel, showValues, stacked = false, series = [], seriesLabel = "" }) {
  if (stacked) return <StackedSqlBarChart bars={bars} xLabel={xLabel} yLabel={yLabel} showValues={showValues} series={series} seriesLabel={seriesLabel} />;
  const width = Math.max(720, bars.length * 58 + 76);
  const height = 290;
  const pad = { left: 64, right: 20, top: 35, bottom: 58 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const minimum = Math.min(0, ...bars.map((bar) => bar.value));
  const maximum = Math.max(0, ...bars.map((bar) => bar.value));
  const high = maximum === minimum ? 1 : maximum;
  const yFor = (value) => pad.top + ((high - value) / (high - minimum)) * plotHeight;
  const zero = yFor(0);
  const ticks = [minimum, 0, high].filter((value, index, values) => values.indexOf(value) === index);
  const step = plotWidth / bars.length;
  const barWidth = Math.max(8, step - 14);

  return <div className="overflow-x-auto border border-stone-300 bg-white px-2 py-3" role="img" aria-label={`Bar chart: ${xLabel} on the X-axis and ${yLabel} on the Y-axis, ${bars.length} bars`}>
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="bar-chart max-w-none" aria-hidden="true">
      {ticks.map((tick) => <g key={tick}>
        <line x1={pad.left} x2={width - pad.right} y1={yFor(tick)} y2={yFor(tick)} stroke="#d6d3d1" strokeWidth="1" />
        <text x={pad.left - 9} y={yFor(tick) + 4} textAnchor="end" fill="#78716c" fontSize="11">{formatNumber.format(tick)}</text>
      </g>)}
      {bars.map((bar, index) => {
        const x = pad.left + index * step + (step - barWidth) / 2;
        const end = yFor(bar.value);
        const top = Math.min(zero, end);
        const bottom = Math.max(zero, end);
        const valueY = bar.value >= 0 ? Math.max(14, top - 7) : Math.min(height - pad.bottom - 3, bottom + 14);
        return <g key={index}>
          <rect x={x} y={top} width={barWidth} height={Math.max(1, bottom - top)} fill="#166534">
            <title>{bar.label}: {formatNumber.format(bar.value)}</title>
          </rect>
          {showValues && <text x={x + barWidth / 2} y={valueY} textAnchor="middle" fill="#57534e" fontSize="10">{formatNumber.format(bar.value)}</text>}
          <text x={x + barWidth / 2} y={height - 32} textAnchor="middle" fill="#57534e" fontSize="11">
            <title>{bar.label}</title>{shortLabel(bar.label)}
          </text>
        </g>;
      })}
      <text x={pad.left + plotWidth / 2} y={height - 8} textAnchor="middle" fill="#57534e" fontSize="11">{xLabel}</text>
    </svg>
  </div>;
}
