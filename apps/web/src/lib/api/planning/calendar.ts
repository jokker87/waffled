// Step 2 · Calendar — this step's API client.
//
// DELIBERATELY EMPTY. The calendar step reads the week with `useEventsRange` and adds to
// it by opening the app's own `EventModal`, which already writes through the local-first
// path (`createEventLocal`, falling back to `eventsApi.createEvent`). Both are already in
// ../events. A client here would be a second way to talk to the calendar, and two ways is
// how the offline path and the REST path drift apart.
//
// `export {}` keeps this a module so ./index.ts's `export * from './calendar'` still
// resolves. If this step ever does need something of its own, it goes here — import
// { apiGet, apiSend } from '../client' and emit('weeklyPlanning') after a write.
export {}
