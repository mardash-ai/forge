/**
 * The seed fixtures offered by the test-tenant screen.
 *
 * Extracted from App.tsx so they can be TESTED. They are data that has to satisfy real invariants —
 * every date relative, every delegation's status explicit — and an invariant with no test is a
 * convention that decays. See tests/console-fixtures.test.ts.
 */

export type FixtureAudience = 'any' | 'owner' | 'member';

/**
 * Test tenants — the fixtures the acceptance harness drives.
 *
 * Separate from Accounts on purpose. Reset and purge are not the same operation at different
 * intensities, they run on different surfaces behind different credentials, and putting them on one
 * screen would be an invitation to reach for the wrong one.
 */
/**
 * Ready-made fixtures.
 *
 * They exist because the alternative is a blank JSON box, and a blank box makes the fastest path
 * "seed nothing and click around an empty account" — which tests almost nothing. Each of these
 * produces a tenant with something worth looking at.
 *
 * ⛔ EVERY DATE IS RELATIVE (`{ days, hour }`), never absolute. A fixture with hard-coded dates rots
 * silently: "due tomorrow" becomes "overdue by nine months", and the suite then fails on at-risk
 * assertions for reasons that have nothing to do with the product.
 */
/**
 * Fixtures, tagged with WHO they make sense for.
 *
 * `owner` fixtures build a household, and the app refuses those on a member with a 403 —
 * `members.invite` is an owner-only permission in the product's role matrix, so a seed that added
 * members to a member would create a household shape no real user could produce. Offering them and
 * letting the API reject is worse than not offering them: it teaches the operator that errors here
 * are normal.
 *
 * `member` fixtures produce the private/shared mix a teen or assistant actually has, which is what
 * the privacy workflows need to assert against.
 */
export const FIXTURES: ReadonlyArray<readonly [string, string, unknown, FixtureAudience]> = [
  ['empty', 'Empty — no data', {}, 'any'],
  [
    'starter',
    'Starter — a few loops, people and events',
    {
      timezone: 'America/New_York',
      people: [
        { displayName: 'Robin Cruz', relationship: 'partner' },
        { displayName: 'Dr. Alvarez', relationship: 'pediatrician' },
      ],
      delegations: [
        {
          title: 'Book the annual check-up',
          request: 'Call Dr. Alvarez and book the annual check-up',
          // ⛔ STATUS MATTERS. Home buckets delegations into needs-you / today / handled, and
          // `inbox` — the default — is in NONE of them, so a seeded delegation rendered nowhere.
          // Every fixture here sets a status that actually surfaces somewhere a tester will look.
          status: 'waiting-on-person',
          dueAt: { days: 3, hour: 17 },
          stakeholders: ['Dr. Alvarez'],
        },
        {
          title: 'Renew the car registration',
          request: 'Renew the car registration before it lapses',
          status: 'in-progress',
          dueAt: { days: 10, hour: 12 },
        },
      ],
      events: [{ title: 'Parent-teacher conference', startAt: { days: 2, hour: 18 } }],
      reminders: [{ subject: 'Pack the forms', fireAt: { days: 1, hour: 8 } }],
      notes: [{ text: 'Insurance card is in the blue folder' }],
    },
    'any',
  ],
  [
    'overdue',
    'Overdue — work already past due, for at-risk and escalation',
    {
      timezone: 'America/New_York',
      people: [{ displayName: 'Robin Cruz', relationship: 'partner' }],
      delegations: [
        {
          title: 'Send the enrolment form',
          request: 'Send the enrolment form to the school office',
          // at-risk lands in Home's needs-you bucket, which is where an overdue item belongs.
          status: 'at-risk',
          // NEGATIVE days: already overdue at seed time, which is what makes the overdue sweep and
          // the at-risk surface testable WITHOUT having to move the clock first.
          dueAt: { days: -2, hour: 9 },
        },
        {
          title: 'Reschedule the dentist',
          request: 'Reschedule the dentist appointment',
          status: 'waiting-on-user',
          dueAt: { days: -1, hour: 15 },
        },
      ],
      reminders: [{ subject: 'Chase the school office', fireAt: { days: -1, hour: 8 } }],
    },
    'any',
  ],
  [
    'household',
    'Household — a family with members (creates the member accounts)',
    {
      timezone: 'America/New_York',
      householdName: 'The Cruz family',
      // Members are named by EMAIL. Any that do not exist are CREATED as test tenants by the seed —
      // which is the whole reason this preset is here: the shape used to need owner IDs you had to
      // go and find, so building a household looked impossible from this screen.
      members: [
        { email: 'jamie@dorinda.test', displayName: 'Jamie', role: 'adult' },
        { email: 'riley@dorinda.test', displayName: 'Riley', role: 'teen' },
      ],
      people: [
        { displayName: 'Dana Whitfield', relationship: 'contractor', emails: ['dana@example.com'] },
        { displayName: 'Marcus Reed', relationship: 'pediatrician' },
      ],
      /*
       * EVERY delegation carries an explicit `status`, and the three chosen here land in three
       * different places in the product on purpose.
       *
       * `createDelegation` defaults an omitted status to `inbox`, and the web app's Tracking page
       * EXCLUDES `inbox`/`needs-clarification` (they are un-triaged, so they belong to the Inbox
       * page instead). A fixture that omitted the status therefore seeded a tenant whose Tracking
       * page was empty while the tally said "3 delegations" — which reads as a broken seed rather
       * than as the product's inbox-then-triage model working correctly.
       *
       *   waiting-on-person  -> Tracking. The classic loop: handed off, waiting on someone else.
       *   waiting-on-user    -> Tracking AND the needs-you bucket: the next action is the user's.
       *   inbox              -> the Inbox page only. Kept deliberately, so one seeded tenant shows
       *                         BOTH sides of the split and the exclusion is visible, not a mystery.
       *
       * `stakeholders` are display names resolved against `people` above (never ids), which is why
       * people are seeded first.
       */
      delegations: [
        {
          title: 'Kitchen backsplash quote',
          request: 'Get a written quote from Dana for the kitchen backsplash.',
          interpretedOutcome: 'A written quote with materials and labor broken out.',
          completionCriteria: 'Quote received in writing with a total dollar figure.',
          status: 'waiting-on-person',
          priority: 'medium',
          stakeholders: ['Dana Whitfield'],
          dueAt: { days: 5, hour: 17 },
        },
        {
          title: 'Send Marcus the updated immunization records',
          request: 'Email the school immunization form to the pediatrician.',
          status: 'waiting-on-user',
          priority: 'high',
          stakeholders: ['Marcus Reed'],
          dueAt: { days: 2, hour: 9 },
        },
        {
          title: 'Look into summer camp options',
          request: 'Someone mentioned a robotics camp in July — worth checking.',
          status: 'inbox',
        },
      ],
    },
    'owner',
  ],
  [
    'imminent',
    'Imminent — fires within an hour of an advance',
    {
      timezone: 'America/New_York',
      events: [{ title: 'Standup', startAt: { days: 0, hour: 23 } }],
      reminders: [
        { subject: 'Leave for the school run', fireAt: { days: 0, hour: 23 } },
        { subject: 'Take the medication', fireAt: { days: 1, hour: 7 } },
      ],
      delegations: [
        {
          title: 'Confirm the sitter',
          request: 'Confirm the sitter for Friday',
          // Explicit, like every other fixture delegation: an omitted status defaults to `inbox`,
          // which the Tracking page excludes. This preset exists to watch things FIRE, so its
          // delegation has to sit where both the firing paths and the UI actually look.
          status: 'waiting-on-person',
          dueAt: { days: 1, hour: 9 },
        },
      ],
    },
    'any',
  ],
  [
    'member-teen',
    'Teen — private work plus one thing shared up to a parent',
    {
      timezone: 'America/New_York',
      // A teen holds `resource.private` and `resource.share_up` but NOT `resource.share`: they can
      // hand something to the household owner without publishing to everyone. This fixture produces
      // exactly that mix, which is what the privacy workflows assert against.
      delegations: [
        {
          title: 'Study for the chem test',
          request: 'Revise chapters 4-6',
          status: 'in-progress',
          dueAt: { days: 2, hour: 19 },
        },
        {
          title: 'Sports physical form',
          request: 'Give the signed physical form to a parent',
          status: 'waiting-on-user',
          dueAt: { days: 4, hour: 17 },
        },
      ],
      reminders: [{ subject: 'Practice at 4', fireAt: { days: 1, hour: 15 } }],
    },
    'member',
  ],
  [
    'member-assistant',
    'Assistant — captured work only, nothing shared or staged',
    {
      timezone: 'America/New_York',
      // An assistant holds create + private + read-shared + share-up, and deliberately NOT
      // `message.stage` or `policy.manage`. Everything here is operational capture.
      delegations: [
        {
          title: 'Book the plumber',
          request: 'Get three quotes for the leak',
          status: 'in-progress',
          dueAt: { days: 3, hour: 12 },
        },
      ],
      notes: [{ text: 'Landlord prefers texts, not calls' }],
    },
    'member',
  ],
];
