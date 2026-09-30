'use client';

import { type CSSProperties, type ReactNode, useId, useState } from 'react';
import { CASHFLOW_COLORS } from '@/components/cashflow-chart';
import { centsFromDecimal, displayCents } from '@/lib/money';

type Amount = string | number;
/** One bucket of spend, cumulative to the period end (validated + pending = committed). */
type Spend = {
  id: string | null; name: string; validated: Amount; pending: Amount; committed: Amount;
  expense_count: number; share_percent: Amount;
};
export type CategorySpend = Spend;
export type SubitemSpend = Spend & { categories: CategorySpend[] };
export type ItemSpend = Spend & { categories: CategorySpend[]; subitems: SubitemSpend[] };
export type ProviderSpend = Spend;

/** Validated with the dataviz palette checker on #fffdfa; legacy rows use a neutral gray. */
export const CATEGORY_COLORS: Record<string, string> = {
  MATERIAL: '#c0602f', 'MANO DE OBRA': '#6b4fbb', 'EQUIPO/HERR': '#00889c',
};
const NEUTRAL = '#9a948a';
const PENDING_TINT = '#a9d3bf'; // lighter step of the validated green, always labelled

const cents = (value: Amount) => centsFromDecimal(String(value)) ?? 0n;
const percent = (value: Amount) => `${Number(value).toFixed(1)} %`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const slug = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-');

/** Largest committed amount: every bar of one chart shares this axis. */
function axisOf(values: Spend[]): bigint {
  return values.reduce((max, value) => (cents(value.committed) > max ? cents(value.committed) : max), 0n);
}

function widthOn(axis: bigint) {
  return (value: Amount) => (axis > 0n ? (Number(cents(value)) / Number(axis)) * 100 : 0);
}

function SeriesLegend({ label }: { label: string }) {
  return <ul className="chart-legend" aria-label={label}>
    <li><i style={{ background: CASHFLOW_COLORS.validated }} aria-hidden="true" />Validado</li>
    <li><i style={{ background: PENDING_TINT }} aria-hidden="true" />Pendiente de validar</li>
  </ul>;
}

/** Validated bar + pending continuation on a shared axis, with a hover/focus tooltip. */
function SpendBar({ value, width, tooltipId, active, children }: {
  value: Spend; width: (amount: Amount) => number; tooltipId: string; active: boolean; children: ReactNode;
}) {
  const pending = cents(value.pending) > 0n;
  return <span className="item-track">
    <span className={`item-bar validated${pending ? ' joined' : ''}`} data-width={width(value.validated).toFixed(2)} style={{ '--width': `${width(value.validated)}%`, '--color': CASHFLOW_COLORS.validated } as CSSProperties} />
    {pending && <span className="item-bar pending" style={{ '--left': `${width(value.validated)}%`, '--width': `${width(value.pending)}%`, '--color': PENDING_TINT } as CSSProperties} />}
    {active && <span role="tooltip" id={tooltipId} className="chart-tooltip item-tooltip" style={{ left: `${width(value.committed)}%` }}>{children}</span>}
  </span>;
}

function SpendValue({ value }: { value: Spend }) {
  return <span className="item-value">{displayCents(cents(value.validated))}{cents(value.pending) > 0n && <small>+ {displayCents(cents(value.pending))} pend.</small>}</span>;
}

function useHover() {
  const [active, setActive] = useState<string | null>(null);
  const bind = (key: string) => ({
    onMouseEnter: () => setActive(key), onMouseLeave: () => setActive(null),
    onFocus: () => setActive(key), onBlur: () => setActive(null),
  });
  return { active, setActive, bind };
}

function CategoryChips({ categories, label }: { categories: CategorySpend[]; label: string }) {
  return <ul className="category-chips" aria-label={label}>
    {categories.filter((category) => cents(category.committed) > 0n).map((category) => <li key={category.name} data-testid={`chip-${slug(category.name)}`}>
      <i style={{ background: CATEGORY_COLORS[category.name] || NEUTRAL }} aria-hidden="true" />
      <span>{category.name}</span>
      <strong>{displayCents(cents(category.validated))}</strong>
      {cents(category.pending) > 0n && <small>+ {displayCents(cents(category.pending))} pend.</small>}
    </li>)}
  </ul>;
}

/**
 * Cumulative spend by the 23-item catalog with a drill-down Partida → Subpartida →
 * Categoría, and the validated split by category (Cambio 8). The NEODATA total stays
 * the global ceiling elsewhere; shares here are of the validated spend. Every value
 * is also printed and repeated in sr-only tables.
 */
export function SpendBreakdown({ items, categories }: { items: ItemSpend[]; categories: CategorySpend[] }) {
  const id = useId();
  const { active, setActive, bind } = useHover();
  const [expanded, setExpanded] = useState<string[]>([]);
  const totalValidated = categories.reduce((sum, category) => sum + cents(category.validated), 0n);
  const width = widthOn(axisOf(items));

  function toggle(key: string) {
    setExpanded((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key]);
  }

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
              aria-describedby={active === key ? `${id}-tip` : undefined} {...bind(key)}
              onClick={() => setActive((current) => (current === key ? null : key))}>
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
      <h3 id={`${id}-items`} className="breakdown-title">Por partida <small>{items.length} con movimientos · despliega cada una para ver subpartidas y categorías</small></h3>
      <SeriesLegend label="Leyenda de partidas" />
      {items.length === 0
        ? <p className="empty-state compact">Aún no hay gastos registrados en el periodo.</p>
        : <div className="item-rows">{items.map((item) => {
          const key = `item-${item.name}`;
          const open = expanded.includes(key);
          const panelId = `${id}-${slug(item.name)}`;
          return <div key={key} className={`item-group${open ? ' open' : ''}`}>
            <button type="button" className="item-row" data-testid={`item-row-${item.name}`}
              aria-expanded={open} aria-controls={panelId}
              aria-label={`${item.name}: ${displayCents(cents(item.validated))} validado, ${displayCents(cents(item.pending))} pendiente, ${plural(item.expense_count, 'gasto')}. ${open ? 'Ocultar' : 'Ver'} subpartidas`}
              aria-describedby={active === key ? `${id}-tip` : undefined} {...bind(key)} onClick={() => toggle(key)}>
              <span className="item-name"><span className="item-caret" aria-hidden="true" />{item.name}<small>{plural(item.expense_count, 'gasto')} · {percent(item.share_percent)} del validado</small></span>
              <SpendBar value={item} width={width} tooltipId={`${id}-tip`} active={active === key}>
                <strong>{item.name}</strong>
                <span>{displayCents(cents(item.validated))} validado</span>
                {cents(item.pending) > 0n && <small>+ {displayCents(cents(item.pending))} pendiente</small>}
                {item.categories.filter((category) => cents(category.committed) > 0n).map((category) => <small key={category.name}>{category.name}: {displayCents(cents(category.validated))}</small>)}
              </SpendBar>
              <SpendValue value={item} />
            </button>
            <div id={panelId} className="subitem-panel" role="region" aria-label={`Subpartidas de ${item.name}`} hidden={!open}>
              {open && item.subitems.map((subitem) => {
                const subKey = `${key}-${subitem.name}`;
                return <div key={subKey} className="subitem" data-testid={`subitem-${slug(item.name)}-${slug(subitem.name)}`}>
                  <div className="item-row subitem-row" tabIndex={0} aria-label={`${subitem.name}: ${displayCents(cents(subitem.validated))} validado, ${displayCents(cents(subitem.pending))} pendiente`}
                    aria-describedby={active === subKey ? `${id}-tip` : undefined} {...bind(subKey)}>
                    <span className="item-name">{subitem.name}<small>{plural(subitem.expense_count, 'gasto')} · {percent(subitem.share_percent)} del validado</small></span>
                    <SpendBar value={subitem} width={width} tooltipId={`${id}-tip`} active={active === subKey}>
                      <strong>{item.name} › {subitem.name}</strong>
                      <span>{displayCents(cents(subitem.validated))} validado</span>
                      {cents(subitem.pending) > 0n && <small>+ {displayCents(cents(subitem.pending))} pendiente</small>}
                    </SpendBar>
                    <SpendValue value={subitem} />
                  </div>
                  <CategoryChips categories={subitem.categories} label={`Categorías de ${subitem.name}`} />
                </div>;
              })}
            </div>
          </div>;
        })}</div>}
    </section>

    <table className="sr-only">
      <caption>Gasto acumulado por partida y subpartida</caption>
      <thead><tr><th scope="col">Partida / subpartida</th><th scope="col">Validado</th><th scope="col">Pendiente</th><th scope="col">% del validado</th></tr></thead>
      <tbody>{items.flatMap((item) => [
        <tr key={item.name}><th scope="row">{item.name}</th><td>{displayCents(cents(item.validated))}</td><td>{displayCents(cents(item.pending))}</td><td>{percent(item.share_percent)}</td></tr>,
        ...item.subitems.map((subitem) => <tr key={`${item.name}-${subitem.name}`}><th scope="row">{item.name} › {subitem.name}</th><td>{displayCents(cents(subitem.validated))}</td><td>{displayCents(cents(subitem.pending))}</td><td>{percent(subitem.share_percent)}</td></tr>),
      ])}</tbody>
    </table>
    <table className="sr-only">
      <caption>Gasto validado por categoría</caption>
      <thead><tr><th scope="col">Categoría</th><th scope="col">Validado</th><th scope="col">%</th></tr></thead>
      <tbody>{categories.map((category) => <tr key={category.name}><th scope="row">{category.name}</th><td>{displayCents(cents(category.validated))}</td><td>{percent(category.share_percent)}</td></tr>)}</tbody>
    </table>
  </div>;
}

/** Every supplier with spend, largest validated first, on a shared axis. */
export function ProviderSpendChart({ providers }: { providers: ProviderSpend[] }) {
  const id = useId();
  const { active, bind } = useHover();
  const width = widthOn(axisOf(providers));
  if (providers.length === 0) return <p className="empty-state">Aún no hay gastos con proveedor en el periodo.</p>;
  return <div className="provider-spend">
    <SeriesLegend label="Leyenda de proveedores" />
    <div className="item-rows">{providers.map((provider) => {
      const key = `provider-${provider.name}`;
      return <div key={key} className="item-row provider-row" tabIndex={0} data-testid={`provider-row-${provider.name}`}
        aria-label={`${provider.name}: ${displayCents(cents(provider.validated))} validado, ${displayCents(cents(provider.pending))} pendiente, ${percent(provider.share_percent)} del gasto validado, ${plural(provider.expense_count, 'gasto')}`}
        aria-describedby={active === key ? `${id}-tip` : undefined} {...bind(key)}>
        <span className="item-name">{provider.name}<small>{plural(provider.expense_count, 'gasto')} · {percent(provider.share_percent)} del validado</small></span>
        <SpendBar value={provider} width={width} tooltipId={`${id}-tip`} active={active === key}>
          <strong>{provider.name}</strong>
          <span>{displayCents(cents(provider.validated))} validado</span>
          <small>{displayCents(cents(provider.pending))} pendiente</small>
          <small>{percent(provider.share_percent)} del gasto validado de la obra</small>
        </SpendBar>
        <SpendValue value={provider} />
      </div>;
    })}</div>
    <table className="sr-only">
      <caption>Gasto por proveedor</caption>
      <thead><tr><th scope="col">Proveedor</th><th scope="col">Validado</th><th scope="col">Pendiente</th><th scope="col">Gastos</th><th scope="col">% del validado</th></tr></thead>
      <tbody>{providers.map((provider) => <tr key={provider.name}><th scope="row">{provider.name}</th><td>{displayCents(cents(provider.validated))}</td><td>{displayCents(cents(provider.pending))}</td><td>{provider.expense_count}</td><td>{percent(provider.share_percent)}</td></tr>)}</tbody>
    </table>
  </div>;
}
