const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../scripts/timelineWorkload.ts');

test('workload counts inclusive ranges, overlaps and multiple assignees without duplicates', async () => {
  const { buildDailyWorkload } = await load();
  const result = buildDailyWorkload([
    { people: ['@a', '@a', '@b'], dates: { start: 10, end: 12 } },
    { people: ['@a'], dates: { start: 11, end: 13 } },
    { people: [], dates: { start: 10, end: 12 } },
  ], 10, 12);
  assert.equal(result.peak, 2);
  assert.deepEqual(result.people, [
    { person: '@a', days: [{ day: 10, count: 1 }, { day: 11, count: 2 }, { day: 12, count: 2 }] },
    { person: '@b', days: [{ day: 10, count: 1 }, { day: 11, count: 1 }, { day: 12, count: 1 }] },
  ]);
});
test('workload clips to visible days, keeps people with offscreen assignments, and handles open dates', async () => {
  const { buildDailyWorkload } = await load();
  const entries = [
    { people: ['@a'], dates: { start: 11, end: null } },
    { people: ['@b'], dates: { start: null, end: 12 } },
    { people: ['@c'], dates: { start: 100, end: 102 } },
  ];
  const result = buildDailyWorkload(entries, 10, 13, false);
  assert.deepEqual(result.people.map(row => row.days), [[{ day: 11, count: 1 }], [{ day: 12, count: 1 }], []]);
  const open = buildDailyWorkload(entries, 10, 13, true);
  assert.equal(open.people[0].days.length, 3);
  assert.equal(open.people[1].days.length, 3);
});
test('box sizes adapt to the visible peak while a single task remains small', async () => {
  const { workloadBoxSize } = await load();
  assert.equal(workloadBoxSize(0, 5), 0);
  assert.equal(workloadBoxSize(1, 1), 7);
  assert.equal(workloadBoxSize(1, 5), 7);
  assert.equal(workloadBoxSize(2, 2), 24);
  assert.equal(workloadBoxSize(5, 5), 24);
  assert.ok(workloadBoxSize(2, 5) > 7 && workloadBoxSize(2, 5) < 24);
});
