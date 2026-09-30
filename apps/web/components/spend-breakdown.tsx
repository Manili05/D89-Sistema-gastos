'use client';

import { type CSSProperties, useId, useState } from 'react';
import { CASHFLOW_COLORS } from '@/components/cashflow-chart';
import { centsFromDecimal, displayCents } from '@/lib/money';

type Amount = string | number;
export type ItemSpend = {
  id: string | null; name: string; validated: Amount; committed: Amount; pending: Amount;
  expense_count: number; share_percent: Amount; categories: { name: string; validated: Amount }[];
};
export type CategorySpend = {
  id: string | null; name: string; validated: Amount; committed: Amount; share_percent: Amount;
};

/** Validated with the dataviz palette checker on #fffdfa; legacy rows use a neutral gray. */
export const CATEGORY_COLORS: Record<string, string> = {
  MATERIAL: '#c0602f', 'MANO DE OBRA': '#6b4fbb', 'EQUIPO/HERR': '#00889c',
};
const NEUTRAL = '#9a948a';
const PENDING_TINT = '#a9d3bf'; // lighter step of the validated green, always labelled

const cents = (value: Amount) => centsFromDecimal(String(value)) ?? 0n;
const percent = (value: Amount) => `${Number(value).toFixed(1)} %`;

/**
 * Cumulative spend by the 23-item catalog and by category (Cambio 8). The NEODATA
 * total stays the global ceiling elsewhere; here amounts are compared to the
 * validated spend. Every value is also printed and repeated in an sr-only table.
 */
export function SpendBreakdown({ items, categories }: { items: ItemSpend[]; categories: CategorySpend[] }) {
  const id = useId();
  const [active, setActive] = useState<string | null>(null);
  const totalValidated = categories.reduce((sum, category) => sum + cents(category.validated), 0n);
  const axisMax = items.reduce((max, item) => (cents(item.committed) > max ? cents(item.committed) : max), 0n);
  const width = (value: Amount) => (axisMax > 0n ? (Number(cents(value)) / Number(axisMax)) * 100 : 0);
  const hover = (key: string) => ({
    onMouseEnter: () => setActive(key), onMouseLeave: () => setActive(null),
    onFocus: () => setActive(key), onBlur: () => setActive(null),
    onClick: () => setActive((current) => (current === key ? null : key)),
  });

  return <div className="spend-breakdown">
    <section aria-labelledby={`${id}-cat`}>
      <h3 id={`${id}-cat`} className="breakdown-title">Por categoría <small>gasto validado</small></h3>
      {totalValidated === 0n
        ? <p className="empty-state compact" data-testid="category-empty">Aún no hay gasto validado para repartir por categoría.</p>
        : <div className="category-bar" role="group" aria-label="Gasto validado por categoría">
          {categories.filter((category) => cents(category.validated) > 0n).map((category) => {
            const key = `cat-${category.name}`;
            return <button type="button" key={key} className="category-segment" data-testid={`category-segment-${category.name}`}
              style={{ '--width': `${Number(category.share_percent)}%`, '--color': CATEGORY_COLORS[category.name] || NEUTRAL } as CSSProperties}
              aria-label={`${category.name}: ${displayCents(cents(category.validated))}, ${percent(category.share_percent)}`}
              aria-describedby={active === key ? `${id}-tip` : undefined} {...hover(key)}>
              {active === key && <span role="tooltip" id={`${id}-tip`} className="chart-tooltip category-tooltip">
                <strong>{category.name}</strong><span>{displayCents(cents(category.validated))}</span>
                <small>{percent(category.share_percent)} del gasto validado</small>
              </span>}
            </button>;
          })}
        </div>}
      <ul className="category-legend" aria-label="Categorías">
        {categories.map((category) => <li key={category.name} data-testid={`category-${category.name}`}>
          <i style={{ background: CATEGORY_COLORS[category.name] || NEUTRAL }} aria-hidden="true" />
          <span>{category.name} · <b>{percent(category.share_percent)}</b></span>
          <strong>{displayCents(cents(category.validated))}</strong>
        </li>)}
      </ul>
    </section>

    <section aria-labelledby={`${id}-items`}>
      <h3 id={`${id}-items`} className="breakdown-title">Por partida <small>{items.length} con movimientos · de mayor a menor gasto validado</small></h3>
      <ul className="chart-legend" aria-label="Leyenda de partidas">
        <li><i style={{ background: CASHFLOW_COLORS.validated }} aria-hidden="true" />Validado</li>
        <li><i style={{ background: PENDING_TINT }} aria-hidden="true" />Pendiente de validar</li>
      </ul>
      {items.length === 0
        ? <p className="empty-state compact">Aún no hay gastos registrados en el periodo.</p>
        : <div className="item-rows">{items.map((item) => {
          const key = `item-${item.name}`;
          return <button type="button" key={key} className="item-row" data-testid={`item-row-${item.name}`}
            aria-label={`${item.name}: ${displayCents(cents(item.validated))} validado, ${displayCents(cents(item.pending))} pendiente, ${item.expense_count} gasto${item.expense_count === 1 ? '' : 's'}`}
            aria-describedby={active === key ? `${id}-tip` : undefined} {...hover(key)}>
            <span className="item-name">{item.name}<small>{item.expense_count} gasto{item.expense_count === 1 ? '' : 's'} · {percent(item.share_percent)} del validado</small></span>
            <span className="item-track">
              <span className={`item-bar validated${cents(item.pending) > 0n ? ' joined' : ''}`} data-width={width(item.validated).toFixed(2)} style={{ '--width': `${width(item.validated)}%`, '--color': CASHFLOW_COLORS.validated } as CSSProperties} />
              {cents(item.pending) > 0n && <span className="item-bar pending" style={{ '--left': `${width(item.validated)}%`, '--width': `${width(item.pending)}%`, '--color': PENDING_TINT } as CSSProperties} />}
              {active === key && <span role="tooltip" id={`${id}-tip`} className="chart-tooltip item-tooltip" style={{ left: `${width(item.committed)}%` }}>
                <strong>{item.name}</strong>
                <span>{displayCents(cents(item.validated))} validado</span>
                {cents(item.pending) > 0n && <small>+ {displayCents(cents(item.pending))} pendiente</small>}
                {item.categories.filter((category) => cents(category.validated) > 0n).map((category) => <small key={category.name}>{category.name}: {displayCents(cents(category.validated))}</small>)}
              </span>}
            </span>
            <span className="item-value">{displayCents(cents(item.validated))}{cents(item.pending) > 0n && <small>+ {displayCents(cents(item.pending))} pend.</small>}</span>
          </button>;
        })}</div>}
    </section>

    <table className="sr-only">
      <caption>Gasto acumulado por partida</caption>
      <thead><tr><th scope="col">Partida</th><th scope="col">Validado</th><th scope="col">Pendiente</th><th scope="col">% del validado</th></tr></thead>
      <tbody>{items.map((item) => <tr key={item.name}><th scope="row">{item.name}</th><td>{displayCents(cents(item.validated))}</td><td>{displayCents(cents(item.pending))}</td><td>{percent(item.share_percent)}</td></tr>)}</tbody>
    </table>
    <table className="sr-only">
      <caption>Gasto validado por categoría</caption>
      <thead><tr><th scope="col">Categoría</th><th scope="col">Validado</th><th scope="col">%</th></tr></thead>
      <tbody>{categories.map((category) => <tr key={category.name}><th scope="row">{category.name}</th><td>{displayCents(cents(category.validated))}</td><td>{percent(category.share_percent)}</td></tr>)}</tbody>
    </table>
  </div>;
}
