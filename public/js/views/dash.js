import { esc, badge, fdt, actions, forms, post, toast, modal, closeModal, go, field, textField } from '../lib.js';

/** Dashboard shell: side navigation plus a body column. */
export const dash = (items, active, body) => `<div class="wrap"><div class="dash">
  <nav class="dash-nav card" aria-label="Dashboard">${items.map(([href, label, extra]) => `<a href="#${href}" ${href === active ? 'aria-current="page"' : ''}>${esc(label)}${extra ? `<span class="badge warn">${extra}</span>` : ''}</a>`).join('')}</nav>
  <div class="dash-body">${body}</div></div></div>`;

export const kpi = (label, value, sub = '') => `<div class="card kpi"><div class="l">${esc(label)}</div><div class="v">${value}</div>${sub ? `<div class="tiny muted">${sub}</div>` : ''}</div>`;

const STEPS = [['awaiting_payment', 'Placed'], ['payment_confirmed', 'Paid'], ['seller_processing', 'Processing'], ['ready_for_dispatch', 'Ready'], ['dispatched', 'Dispatched'], ['delivered', 'Delivered'], ['completed', 'Completed']];
export function timeline(status) {
  const idx = STEPS.findIndex((s) => s[0] === status);
  if (idx < 0) return `<p>${badge(status)}</p>`;
  return `<div class="tl" role="list" aria-label="Order progress">${STEPS.map(([k, l], i) => `<div class="s ${i < idx ? 'done' : i === idx ? 'cur' : ''}" role="listitem" ${i === idx ? 'aria-current="step"' : ''}><i></i>${l}</div>`).join('')}</div>`;
}
export const history = (h) => `<ul class="history">${h.map((x) => `<li><div><b>${esc((x.to_status || '').replace(/_/g, ' '))}</b> <span class="muted">by ${esc(x.actor_role || 'system')} · ${fdt(x.created_at)}</span>${x.note ? `<div class="small">${esc(x.note)}</div>` : ''}</div></li>`).join('')}</ul>`;

export const TRANSITION_LABEL = {
  cancelled: ['Cancel order', 'btn-outline'], delivered: ['Mark as delivered', 'btn-primary'], completed: ['Confirm received and complete', 'btn-primary'],
  seller_processing: ['Start processing', 'btn-primary'], ready_for_dispatch: ['Ready for dispatch', 'btn-primary'], dispatched: ['Mark dispatched', 'btn-primary'],
};

/** Buttons for the next allowed steps. Dispatch asks for tracking details first. */
export const actionButtons = (sub) => (sub.actions || []).map((to) => {
  const [l, c] = TRANSITION_LABEL[to] || [to.replace(/_/g, ' '), 'btn-outline'];
  return `<button class="btn ${c}" data-act="sub-transition" data-id="${esc(sub.id)}" data-to="${esc(to)}">${esc(l)}</button>`;
}).join('');

actions['sub-transition'] = async (el) => {
  const { id, to } = el.dataset;
  if (to === 'dispatched') {
    modal(`<h2>Dispatch details</h2><form data-form="dispatch" class="stack mt"><input type="hidden" name="id" value="${esc(id)}">
      ${field('Carrier or courier', 'carrier', { req: true })}${field('Tracking or waybill number', 'trackingRef', { req: true })}
      <p class="err" data-form-error role="alert"></p><div class="row"><button class="btn btn-primary" type="submit">Mark dispatched</button><button class="btn btn-outline" type="button" data-act="close-modal">Cancel</button></div></form>`);
    return;
  }
  if (to === 'cancelled' && !confirm('Cancel this order? This cannot be undone.')) return;
  await post(`/api/seller-orders/${id}/transition`, { to });
  toast('Order updated.', 'ok'); go(location.hash.slice(1));
};
forms.dispatch = async (v) => { await post(`/api/seller-orders/${v.id}/transition`, { to: 'dispatched', carrier: v.carrier, trackingRef: v.trackingRef }); closeModal(); toast('Marked as dispatched.', 'ok'); go(location.hash.slice(1)); };
actions['close-modal'] = () => closeModal();

const reasonModal = (title, formName, id, extra = '', cta = 'Submit') => modal(`<h2>${esc(title)}</h2><form data-form="${formName}" class="stack mt"><input type="hidden" name="id" value="${esc(id)}">${extra}
  ${textField('Reason', 'reason', { req: true, rows: 4 })}<p class="err" data-form-error role="alert"></p><div class="row"><button class="btn btn-primary" type="submit">${esc(cta)}</button><button class="btn btn-outline" type="button" data-act="close-modal">Cancel</button></div></form>`);
actions['open-dispute'] = (el) => reasonModal('Open a dispute', 'dispute', el.dataset.id, '', 'Open dispute');
actions['open-refund'] = (el) => reasonModal('Request a refund', 'refund-request', el.dataset.id, '', 'Request refund');
forms.dispute = async (v) => { await post(`/api/seller-orders/${v.id}/dispute`, { reason: v.reason }); closeModal(); toast('Dispute opened. Our team will review it.', 'ok'); go(location.hash.slice(1)); };
forms['refund-request'] = async (v) => { await post(`/api/seller-orders/${v.id}/refund-request`, { reason: v.reason }); closeModal(); toast('Refund requested.', 'ok'); go(location.hash.slice(1)); };
