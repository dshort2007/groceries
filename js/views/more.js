// The "More" tab: tools that don't need a tab of their own.

import { h, rerender } from '../ui.js';
import { renderGroceries } from './groceries.js';
import { renderSideJob, sideJobSettings } from './sidejob.js';
import { renderReports } from './reports.js';
import { renderBackup } from './backup.js';

let section = 'groceries';

export function renderMore() {
  const sections = [
    ['groceries', 'Groceries', renderGroceries],
    ['reports', 'Reports', renderReports],
    ['sidejob', sideJobSettings().name, renderSideJob],
    ['backup', 'Backup', renderBackup],
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
