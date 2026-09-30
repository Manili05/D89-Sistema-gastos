'use client';

import { type CSSProperties, useId, useState } from 'react';
import { StatusPill } from '@/components/status-pill';
import { centsFromDecimal, displayCents } from '@/lib/money';

type Amount = string | number;

/** Validated with the dataviz palette checker on #fffdfa (lightness, chroma, CVD, contrast). */
export const CASHFLOW_COLORS = { validated: '#1f8055', reconciled: '#3a62b8' } as const;

const compact = new Intl.NumberFormat('es-MX', {
  style: 'currency', currency: 'MXN', notation: 'compact', maximumFractionDigits: 1,
});

/** Smallest 1/2/2.5/5 × 10^k at or above the value, so the axis ends on a round number. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 2.5, 5, 10].find((step) => step * power >= value) ?? 10) * power;
}

/**
 * Validated expense vs reconciled income on one common MXN axis. Each bar is a
 * button: hover, keyboard focus or tap shows its tooltip; the sr-only table carries
 * the same numbers, and the health sentence never relies on color alone.
 */
export function CashflowChart({ validated, reconciled }: { validated?: Amount; reconciled?: Amount }) {
  const id = useId();
  const [active, setActive] = useState<string | null>(null);
  const expense = { key: 'validated', label: 'Gasto validado', color: CASHFLOW_COLORS.validated, cents: centsFromDecimal(validated) ?? 0n };
  const income = { key: 'reconciled', label: 'Ingreso conciliado', color: CASHFLOW_COLORS.reconciled, cents: centsFromDecimal(reconciled) ?? 0n };
  const series = [expense, income];
  const axisMax = niceMax(Math.max(...series.map((item) => Number(item.cents) / 100)));
  const ticks = [0, axisMax / 2, axisMax];
  const coverage = expense.cents > 0n ? Number((income.cents * 10000n) / expense.cents) / 100 : null;
  const covered = income.cents >= expense.cents;

  let health = 'Aún no hay gasto validado ni ingreso conciliado en el periodo.';
  if (coverage !== null) health = `El ingreso conciliado cubre ${coverage.toFixed(1)} % del gasto validado.`;
  else if (income.cents > 0n) health = 'Hay ingreso conciliado y todavía no hay gasto validado.';

  return <figure className="cashflow-chart" aria-labelledby={`${id}-caption`}>
    <figcaption id={`${id}-caption`} className="sr-only">Gasto validado contra ingreso conciliado, en pesos mexicanos</figcaption>
    <ul className="chart-legend" aria-label="Leyenda">
      {series.map((item) => <li key={item.key}><i style={{ background: item.color }} aria-hidden="true" />{item.label}</li>)}
    </ul>
    <div className="cashflow-plot">
      {series.map((item) => {
        const value = Number(item.cents) / 100;
        const width = value > 0 ? Math.max((value / axisMax) * 100, 0.6) : 0;
        const tooltipId = `${id}-${item.key}-tip`;
        const other = item.key === 'validated' ? income : expense;
        return <button type="button" key={item.key} className="cashflow-row" data-testid={`cashflow-bar-${item.key}`}
          aria-describedby={active === item.key ? tooltipId : undefined}
          aria-label={`${item.label}: ${displayCents(item.cents)}`}
          onMouseEnter={() => setActive(item.key)} onMouseLeave={() => setActive(null)}
          onFocus={() => setActive(item.key)} onBlur={() => setActive(null)}
          onClick={() => setActive((current) => (current === item.key ? null : item.key))}>
          <span className="cashflow-label">{item.label}</span>
          <span className="cashflow-track">
            {ticks.slice(1).map((tick) => <span key={tick} className="cashflow-grid" style={{ left: `${(tick / axisMax) * 100}%` }} />)}
            <span className="cashflow-bar" data-width={width.toFixed(2)} style={{ '--width': `${width}%`, '--color': item.color } as CSSProperties} />
            {active === item.key && <span role="tooltip" id={tooltipId} className="chart-tooltip" style={{ left: `${width}%` }}>
              <strong>{item.label}</strong>
              <span>{displayCents(item.cents)}</span>
              <small>{other.label}: {displayCents(other.cents)}</small>
            </span>}
          </span>
          <span className="cashflow-value">{displayCents(item.cents)}</span>
        </button>;
      })}
      <div className="cashflow-axis" aria-hidden="true">
        <span />
        <span className="cashflow-ticks">{ticks.map((tick) => <span key={tick} style={{ left: `${(tick / axisMax) * 100}%` }}>{compact.format(tick)}</span>)}</span>
        <span />
      </div>
    </div>
    <p className="cashflow-health" data-testid="cashflow-health">
      {coverage !== null && <StatusPill tone={covered ? 'green' : 'amber'}>{covered ? 'Gasto cubierto' : 'Cobertura parcial'}</StatusPill>}
      <span>{health}</span>
    </p>
    <table className="sr-only">
      <caption>Gasto validado contra ingreso conciliado</caption>
      <thead><tr><th scope="col">Serie</th><th scope="col">Importe</th></tr></thead>
      <tbody>{series.map((item) => <tr key={item.key}><th scope="row">{item.label}</th><td>{displayCents(item.cents)}</td></tr>)}</tbody>
    </table>
  </figure>;
}
