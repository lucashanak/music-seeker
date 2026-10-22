// collrow.js — sbírky (playlisty, interpreti, pořady) jako řádky.
//
// Mřížka dlaždic je správná tam, kde obal JE ta položka a kde se scanuje očima:
// výsledky hledání, diskografie interpreta. Knihovna je jiný případ — je to
// seznam věcí, které už uživatel zná a hledá v nich podle jména. Spotify to má
// stejně: Your Library je seznam, hledání je mřížka.
//
// Skladby mají vlastní renderer (`renderSongRows` v search.js), protože nesou
// přehrávací kontext, srdce, BPM a délku. Tenhle je pro sbírky: náhled, jméno,
// jeden řádek metadat a ⋯ menu.

import { $, $$, esc, escAttr } from './utils.js';
import { attachContextMenu, wasLongPress, makeKebabButton } from './contextmenu.js';

/**
 * @param container  selektor nebo prvek
 * @param items      pole položek
 * @param opts
 *   thumb(it)     -> URL náhledu, nebo nic
 *   fallback(it)  -> HTML dlaždice, když náhled není (barva + znak)
 *   title(it)     -> text
 *   meta(it)      -> text druhého řádku (typ, počet, poslední album…)
 *   badges(it)    -> HTML vpravo od jména (NEW, Auto…)
 *   round         -> kulatý náhled (interpreti)
 *   onClick(it)   -> otevření
 *   menu(it)      -> objekt pro kontextové menu (stejný tvar jako jinde)
 *   emptyHtml     -> co vykreslit, když je seznam prázdný
 * @returns pole vykreslených řádků
 */
export function renderCollRows(container, items, opts = {}) {
  const el = typeof container === 'string' ? $(container) : container;
  if (!el) return [];
  el.classList.remove('grid');
  if (!items || !items.length) {
    el.innerHTML = opts.emptyHtml || '';
    return [];
  }

  const list = document.createElement('div');
  list.className = 'coll-list' + (opts.round ? ' coll-list-round' : '');

  const rows = items.map((it, i) => {
    const row = document.createElement('div');
    row.className = 'coll-row';
    row.dataset.collIdx = String(i);
    const src = opts.thumb ? opts.thumb(it) : '';
    const meta = opts.meta ? opts.meta(it) : '';
    row.innerHTML = `
      ${src
        ? `<img class="coll-thumb" src="${escAttr(src)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
        : `<div class="coll-thumb">${opts.fallback ? opts.fallback(it) : ''}</div>`}
      <div class="coll-info">
        <div class="coll-title">${esc(opts.title ? opts.title(it) : '')}</div>
        ${meta ? `<div class="coll-meta">${esc(meta)}</div>` : ''}
      </div>
      ${opts.badges ? opts.badges(it) : ''}
    `;
    if (opts.onClick) {
      row.addEventListener('click', (e) => {
        // Kebab a jeho menu si klik řeší samy.
        if (e.target.closest('.kebab-btn')) return;
        if (wasLongPress(row)) return;
        opts.onClick(it, row);
      });
    }
    if (opts.menu) row.appendChild(makeKebabButton(() => opts.menu(it)));
    list.appendChild(row);
    return row;
  });

  el.innerHTML = '';
  el.appendChild(list);

  if (opts.menu) {
    attachContextMenu(list, {
      selector: '.coll-row',
      getItem: (target) => opts.menu(items[parseInt(target.dataset.collIdx, 10)]),
    });
  }
  return rows;
}

/** Kostra pro seznam, dokud se načítá. */
export function collSkeleton(container, n = 6) {
  const el = typeof container === 'string' ? $(container) : container;
  if (!el) return;
  el.classList.remove('grid');
  el.innerHTML = `<div class="coll-list">${Array(n).fill('<div class="skeleton skeleton-coll"></div>').join('')}</div>`;
}
