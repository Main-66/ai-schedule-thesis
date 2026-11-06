# CampusPlan — AI-Assisted Schedule Management

CampusPlan is a web-based university timetable planner. Students can import or manually enter alternative class groups, assign importance to each subject, review the options on a semester calendar, and run a local schedule optimizer to find a low-conflict combination.

## What works in this version

- **Calendar-first workflow:** weekly and monthly calendar views show available class choices, recommended choices, and fixed commitments.
- **Multiple class options per subject:** add a course more than once, each time with a different group, weekday selection, and time range.
- **Importance levels:** assign each subject an importance from 1 (low priority) to 5 (essential).
- **Multiple weekday selection:** a class group can meet on more than one weekday, e.g. Monday and Wednesday.
- **ICS import:** import recurring events as class options or import calendar events as fixed commitments.
- **CSV import:** import class groups or fixed commitments. A CSV example can also be downloaded from the app.
- **Local optimization:** `Confirm & optimize` searches combinations, respects fixed commitments, minimizes overlaps, and uses subject importance and the user's class-option ranking when choosing between otherwise viable combinations.
- **Browser persistence:** the current plan is saved in the browser's local storage. No account, cloud API key, PostgreSQL service, or backend process is required for the planner UI.

## Start the web app

Requirements: Node.js 20.19+ or 22.12+ and npm.

```bash
cd frontend
npm install
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`).

To create a production build:

```bash
npm run build
npm run preview
```

## Recommended workflow

1. Set the semester start and end dates.
2. Import a timetable file, or enter each subject manually.
3. For each subject, add every possible class group. Give the group a label, then add each weekly meeting under that same label. A group can meet on Monday at 09:00 and Wednesday at 13:00, for example.
4. Set the subject's importance from 1 to 5.
5. Add fixed commitments such as work shifts or appointments, or import them from an ICS/CSV calendar.
6. Review all options in **All options** calendar mode.
7. Press **Confirm & optimize**. The calendar switches to **Best fit** and shows the selected groups and any remaining conflicts.

The class option ordering is editable with the up/down arrows in each subject card. The optimizer uses this ordering together with subject importance when several combinations are equally conflict-free.

## CSV formats

### Class options

Use these exact headers (header capitalization is ignored):

```csv
subject,importance,option,days,start,end
Algorithms,5,Group A,Mon,09:00,10:30
Algorithms,5,Group A,Wed,13:00,14:30
Algorithms,5,Group B,"Tue;Thu",13:00,14:30
Database Systems,4,Group A,"Mon;Thu",11:00,12:30
```

- `subject`: course name. Rows with the same name are grouped under one subject.
- `importance`: integer from 1 to 5.
- `option`: class-group label. Rows with the same subject and option label are combined into one group. This lets a group have different meeting times on different days.
- `days`: day names or abbreviations separated by semicolons, pipes, or commas. Example: `Mon;Wed`.
- `start` / `end`: 24-hour time, `HH:MM`. A row can represent one meeting day or several days that share the same time.

An example file is included at `examples/class-options.csv`.

### Fixed commitments

When **Fixed events** is selected in the import panel, use:

```csv
title,date,start,end
Part-time work,2026-11-09,16:00,18:00
Doctor appointment,2026-11-11,10:00,11:00
```

## ICS import notes

- In **Class options** mode, weekly recurring events are converted into candidate weekly class slots. An event with `RRULE:FREQ=WEEKLY;BYDAY=MO,WE` becomes a slot that meets on Monday and Wednesday.
- A non-recurring event imported in **Class options** mode is treated as a weekly option on the weekday of its start date, because this mode means "these are possible class times".
- In **Fixed events** mode, one-off ICS events stay one-off commitments. Weekly recurring events are expanded over the selected semester date range.
- For the cleanest grouping of separate events into one class group, ICS exports can include `X-SUBJECT`, `X-SECTION`, and optionally `X-IMPORTANCE` properties. Events with the same subject and section are grouped into one option, including when different meeting days have different times.
- All-day ICS events are skipped in this version; timed events are supported.

An example recurring ICS file is included at `examples/class-options.ics`.

## What “AI” means in this no-key prototype

The current `Confirm & optimize` workflow is a local, deterministic constraint-optimization engine. It compares class-group combinations, checks them against one another and fixed commitments, minimizes clashes, and ranks viable choices using importance and option preference. It runs without a paid LLM API key and does not send calendar data to a third party.

This is deliberately different from an LLM response. The previous natural-language parser was wired to Ollama or a cloud-compatible API and could silently create a fake fallback event when its provider was unavailable. The redesigned planner no longer relies on that parser. A future thesis version can add an optional local Ollama explanation layer, while keeping the core timetable optimizer available without an API key.

## Backend

The existing `backend/` directory is retained as the earlier FastAPI/PostgreSQL prototype. The redesigned frontend does not call it for the class-selection and optimization flow. The UI stores its working plan locally in the current browser profile, so start with the frontend instructions above.

For a thesis deployment, the next architectural step is to persist subjects, class options, fixed events, and optimization results through FastAPI and a database, rather than browser local storage.
