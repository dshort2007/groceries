// The "More" tab: tools that don't need a tab of their own.

import { h, rerender } from '../ui.js';
import { renderGroceries } from './groceries.js';
import { renderSideJob, sideJobSettings } from './sidejob.js';

let section = 'groceries';

export function renderMore() {
  const sections = [
    ['groceries', 'Groceries', renderGroceries],
    ['sidejob', sideJobSettings().name, renderSideJob],
  ];
  return [
    h(
      'div',
      { class: 'subtabs sections' },
      sections.map(([id, label]) => h('button', { class: id === section ? 'on' : null, onclick: () => { section = id; rerender(); } }, label))
    ),
    ...sections.find(([id]) => id === section)[2](),
  ];
}
