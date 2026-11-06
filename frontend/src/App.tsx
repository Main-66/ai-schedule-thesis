import { useEffect, useMemo, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import {
  AlertCircle,
  ArrowDownToLine,
  BookOpen,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  FileSpreadsheet,
  FileUp,
  Info,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import "./App.css";

type SlotMeeting = {
  days: number[];
  start: string;
  end: string;
};

type SlotOption = {
  id: string;
  label: string;
  meetings: SlotMeeting[];
  preference: number;
};

type Subject = {
  id: string;
  name: string;
  importance: number;
  options: SlotOption[];
};

type FixedEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
};

type Plan = {
  semesterStart: string;
  semesterEnd: string;
  subjects: Subject[];
  fixedEvents: FixedEvent[];
};

type Selection = { subjectId: string; optionId: string };
type Recommendation = {
  selections: Selection[];
  conflicts: string[];
  missing: string[];
  score: number;
  explored: number;
};

type CalendarMode = "options" | "recommended";
type ImportMode = "options" | "fixed";

const STORAGE_KEY = "campus-planner-v3";
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_PICKER_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_ALIASES: Record<string, number> = {
  su: 0, sun: 0, sunday: 0,
  mo: 1, mon: 1, monday: 1,
  tu: 2, tue: 2, tues: 2, tuesday: 2,
  we: 3, wed: 3, wednesday: 3,
  th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fr: 5, fri: 5, friday: 5,
  sa: 6, sat: 6, saturday: 6,
};

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function defaultPlan(): Plan {
  const today = new Date();
  return {
    semesterStart: dateKey(today),
    semesterEnd: dateKey(addDays(today, 119)),
    subjects: [],
    fixedEvents: [],
  };
}

function loadPlan(): Plan {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPlan();
    const parsed = JSON.parse(raw) as Plan;
    if (!parsed.semesterStart || !parsed.semesterEnd || !Array.isArray(parsed.subjects)) return defaultPlan();
    return { ...defaultPlan(), ...parsed, fixedEvents: Array.isArray(parsed.fixedEvents) ? parsed.fixedEvents : [] };
  } catch {
    return defaultPlan();
  }
}

function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

function parseImportance(value: string | undefined): number {
  const parsed = Number(value || 3);
  return Number.isFinite(parsed) ? Math.min(5, Math.max(1, parsed)) : 3;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function parseDays(value: string): number[] {
  return value
    .split(/[;|,]/)
    .map((part) => DAY_ALIASES[part.trim().toLowerCase()])
    .filter((day): day is number => day !== undefined)
    .filter((day, index, all) => all.indexOf(day) === index)
    .sort((a, b) => a - b);
}

function parseCsv(text: string): string[][] {
  text = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell.trim());
      if (row.some((part) => part.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some((part) => part.length > 0)) rows.push(row);
  return rows;
}

function unfoldIcs(text: string): string[] {
  const physical = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of physical) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  return lines;
}

function unescapeIcs(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

type IcsEvent = { props: Record<string, string>; recurring: boolean; days: number[]; start: string; end: string; date: string; summary: string };

function parseIcsDate(value: string): { date: string; time: string; allDay: boolean } | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  if (!hour) return { date: `${year}-${month}-${day}`, time: "00:00", allDay: true };
  if (trimmed.endsWith("Z")) {
    const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second || 0)));
    return { date: dateKey(utc), time: `${String(utc.getHours()).padStart(2, "0")}:${String(utc.getMinutes()).padStart(2, "0")}`, allDay: false };
  }
  return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}`, allDay: false };
}

function readIcsEvents(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let current: Record<string, string> | null = null;
  for (const line of unfoldIcs(text)) {
    if (line === "BEGIN:VEVENT") current = {};
    else if (line === "END:VEVENT" && current) {
      const rawStart = current.DTSTART?.split("|").at(-1) || "";
      const rawEnd = current.DTEND?.split("|").at(-1) || "";
      const start = parseIcsDate(rawStart);
      const end = parseIcsDate(rawEnd);
      if (start && end && !start.allDay && !end.allDay) {
        const rule = current.RRULE || "";
        const byDay = rule.match(/(?:^|;)BYDAY=([^;]+)/i)?.[1];
        const days = byDay
          ? byDay.split(",").map((d) => DAY_ALIASES[d.slice(-2).toLowerCase()]).filter((d): d is number => d !== undefined)
          : [new Date(`${start.date}T12:00:00`).getDay()];
        events.push({
          props: current,
          recurring: /FREQ=WEEKLY/i.test(rule),
          days: [...new Set(days)].sort((a, b) => a - b),
          start: start.time,
          end: end.time,
          date: start.date,
          summary: unescapeIcs(current.SUMMARY || "Untitled class"),
        });
      }
      current = null;
    } else if (current) {
      const separator = line.indexOf(":");
      if (separator > 0) {
        const nameAndParams = line.slice(0, separator);
        const key = nameAndParams.split(";")[0].toUpperCase();
        const value = line.slice(separator + 1);
        current[key] = current[key] ? `${current[key]}|${value}` : value;
      }
    }
  }
  return events;
}

function semesterDates(start: string, end: string): Date[] {
  const first = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime()) || first > last) return [];
  const dates: Date[] = [];
  for (let cursor = first; cursor <= last && dates.length < 400; cursor = addDays(cursor, 1)) dates.push(new Date(cursor));
  return dates;
}

function meetingOccurrences(meeting: SlotMeeting, start: string, end: string): Array<{ date: string; start: number; end: number }> {
  const startMinutes = timeToMinutes(meeting.start);
  const endMinutes = timeToMinutes(meeting.end);
  return semesterDates(start, end)
    .filter((date) => meeting.days.includes(date.getDay()))
    .map((date) => ({ date: dateKey(date), start: startMinutes, end: endMinutes }));
}

function optionOccurrences(option: SlotOption, start: string, end: string): Array<{ date: string; start: number; end: number }> {
  return option.meetings.flatMap((meeting) => meetingOccurrences(meeting, start, end));
}

function meetingOverlapCount(first: SlotOption, second: SlotOption): number {
  let count = 0;
  for (const firstMeeting of first.meetings) {
    for (const secondMeeting of second.meetings) {
      const sharedDays = firstMeeting.days.filter((day) => secondMeeting.days.includes(day));
      if (sharedDays.length && overlaps(
        timeToMinutes(firstMeeting.start), timeToMinutes(firstMeeting.end),
        timeToMinutes(secondMeeting.start), timeToMinutes(secondMeeting.end),
      )) count += sharedDays.length;
    }
  }
  return count;
}

function optionFixedConflicts(option: SlotOption, fixedEvents: FixedEvent[], start: string, end: string): number {
  const occurrences = optionOccurrences(option, start, end);
  return occurrences.reduce((count, occurrence) => {
    return count + fixedEvents.filter((event) => {
      if (!event.start.startsWith(occurrence.date)) return false;
      const fixedStart = timeToMinutes(event.start.slice(11, 16));
      const fixedEnd = timeToMinutes(event.end.slice(11, 16));
      return overlaps(occurrence.start, occurrence.end, fixedStart, fixedEnd);
    }).length;
  }, 0);
}

function explainConflicts(subjects: Subject[], selections: Selection[], fixedEvents: FixedEvent[], start: string, end: string): string[] {
  const messages: string[] = [];
  const selected = selections
    .map((selection) => {
      const subject = subjects.find((item) => item.id === selection.subjectId);
      const option = subject?.options.find((item) => item.id === selection.optionId);
      return subject && option ? { subject, option } : null;
    })
    .filter((item): item is { subject: Subject; option: SlotOption } => item !== null);

  for (let i = 0; i < selected.length; i += 1) {
    const current = selected[i];
    for (let j = i + 1; j < selected.length; j += 1) {
      const other = selected[j];
      for (const firstMeeting of current.option.meetings) {
        for (const secondMeeting of other.option.meetings) {
          const commonDays = firstMeeting.days.filter((day) => secondMeeting.days.includes(day));
          if (commonDays.length && overlaps(
            timeToMinutes(firstMeeting.start), timeToMinutes(firstMeeting.end),
            timeToMinutes(secondMeeting.start), timeToMinutes(secondMeeting.end),
          )) {
            messages.push(`${current.subject.name} overlaps with ${other.subject.name} on ${commonDays.map((day) => DAY_NAMES[day]).join(", ")}.`);
          }
        }
      }
    }
    for (const occurrence of optionOccurrences(current.option, start, end)) {
      for (const event of fixedEvents) {
        if (event.start.slice(0, 10) !== occurrence.date) continue;
        if (overlaps(occurrence.start, occurrence.end, timeToMinutes(event.start.slice(11, 16)), timeToMinutes(event.end.slice(11, 16)))) {
          messages.push(`${current.subject.name} overlaps with “${event.title}” on ${occurrence.date}.`);
        }
      }
    }
  }
  return [...new Set(messages)];
}

function optimizePlan(plan: Plan): Recommendation {
  const missing = plan.subjects.filter((subject) => subject.options.length === 0).map((subject) => subject.name);
  const activeSubjects = plan.subjects.filter((subject) => subject.options.length > 0);
  const ordered = [...activeSubjects].sort((a, b) => a.options.length - b.options.length || b.importance - a.importance);
  let bestSelections: Selection[] = [];
  let bestConflicts = Number.POSITIVE_INFINITY;
  let bestScore = Number.NEGATIVE_INFINITY;
  let explored = 0;
  const current: Selection[] = [];
  const nodeLimit = 150000;

  function visit(index: number, conflicts: number, score: number): void {
    if (explored >= nodeLimit) return;
    explored += 1;
    if (conflicts > bestConflicts) return;
    if (index === ordered.length) {
      if (conflicts < bestConflicts || (conflicts === bestConflicts && score > bestScore)) {
        bestConflicts = conflicts;
        bestScore = score;
        bestSelections = [...current];
      }
      return;
    }
    const subject = ordered[index];
    const options = [...subject.options].sort((a, b) => a.preference - b.preference);
    for (const option of options) {
      let addedConflicts = optionFixedConflicts(option, plan.fixedEvents, plan.semesterStart, plan.semesterEnd);
      for (const selected of current) {
        const otherSubject = ordered.find((item) => item.id === selected.subjectId);
        const otherOption = otherSubject?.options.find((item) => item.id === selected.optionId);
        if (!otherOption) continue;
        addedConflicts += meetingOverlapCount(option, otherOption);
      }
      const preferenceScore = Math.max(0, subject.options.length - option.preference + 1) * subject.importance * 100;
      current.push({ subjectId: subject.id, optionId: option.id });
      visit(index + 1, conflicts + addedConflicts, score + preferenceScore);
      current.pop();
      if (explored >= nodeLimit) break;
    }
  }

  if (ordered.length) visit(0, 0, 0);
  const conflicts = explainConflicts(activeSubjects, bestSelections, plan.fixedEvents, plan.semesterStart, plan.semesterEnd);
  return {
    selections: bestSelections,
    conflicts,
    missing,
    score: Number.isFinite(bestScore) ? bestScore : 0,
    explored,
  };
}

function downloadCsvTemplate(): void {
  const csv = [
    "subject,importance,option,days,start,end",
    'Algorithms,5,Group A,"Mon",09:00,10:30',
    'Algorithms,5,Group A,"Wed",13:00,14:30',
    'Algorithms,5,Group B,"Tue;Thu",13:00,14:30',
    'Database Systems,4,Group A,"Mon;Thu",11:00,12:30',
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "class-options-template.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatDays(days: number[]): string {
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((day) => DAY_SHORT[day]).join(" · ");
}

function formatMeetings(meetings: SlotMeeting[]): string {
  return meetings.map((meeting) => `${formatDays(meeting.days)} ${meeting.start}–${meeting.end}`).join(" / ");
}

function meetingHasOverlap(meetings: SlotMeeting[], candidate: SlotMeeting): boolean {
  return meetings.some((meeting) => meeting.days.some((day) => candidate.days.includes(day)) && overlaps(
    timeToMinutes(meeting.start), timeToMinutes(meeting.end),
    timeToMinutes(candidate.start), timeToMinutes(candidate.end),
  ));
}

export default function App() {
  const [plan, setPlan] = useState<Plan>(loadPlan);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [calendarMode, setCalendarMode] = useState<CalendarMode>("options");
  const [importMode, setImportMode] = useState<ImportMode>("options");
  const [isImporting, setIsImporting] = useState(false);
  const [notice, setNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [subjectName, setSubjectName] = useState("");
  const [importance, setImportance] = useState(3);
  const [optionLabel, setOptionLabel] = useState("Group A");
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 3]);
  const [classStart, setClassStart] = useState("09:00");
  const [classEnd, setClassEnd] = useState("10:30");

  const [fixedTitle, setFixedTitle] = useState("");
  const [fixedDate, setFixedDate] = useState(dateKey(new Date()));
  const [fixedStart, setFixedStart] = useState("12:00");
  const [fixedEnd, setFixedEnd] = useState("13:00");
  const [showFixedForm, setShowFixedForm] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plan));
  }, [plan]);

  const totalOptions = useMemo(() => plan.subjects.reduce((total, subject) => total + subject.options.length, 0), [plan.subjects]);
  const selectionMap = useMemo(() => new Map((recommendation?.selections || []).map((item) => [item.subjectId, item.optionId])), [recommendation]);

  const calendarEvents = useMemo(() => {
    const events: Array<Record<string, unknown>> = [];
    if (calendarMode === "options") {
      for (const subject of plan.subjects) {
        for (const option of subject.options) {
          const selected = selectionMap.get(subject.id) === option.id;
          option.meetings.forEach((meeting, meetingIndex) => {
            for (const occurrence of meetingOccurrences(meeting, plan.semesterStart, plan.semesterEnd)) {
              events.push({
                id: `${subject.id}-${option.id}-${meetingIndex}-${occurrence.date}`,
                title: `${selected ? "✓ " : ""}${subject.name} · ${option.label}`,
                start: `${occurrence.date}T${meeting.start}:00`,
                end: `${occurrence.date}T${meeting.end}:00`,
                classNames: [selected ? "fc-option-selected" : "fc-option-candidate"],
                backgroundColor: selected ? "#d9f5e9" : "#eaf0fb",
                borderColor: selected ? "#2f9c70" : "#b7c8e8",
                textColor: selected ? "#146548" : "#3b5279",
              });
            }
          });
        }
      }
    } else if (recommendation) {
      for (const selection of recommendation.selections) {
        const subject = plan.subjects.find((item) => item.id === selection.subjectId);
        const option = subject?.options.find((item) => item.id === selection.optionId);
        if (!subject || !option) continue;
        option.meetings.forEach((meeting, meetingIndex) => {
          for (const occurrence of meetingOccurrences(meeting, plan.semesterStart, plan.semesterEnd)) {
            events.push({
              id: `${subject.id}-${option.id}-${meetingIndex}-${occurrence.date}`,
              title: subject.name,
              start: `${occurrence.date}T${meeting.start}:00`,
              end: `${occurrence.date}T${meeting.end}:00`,
              backgroundColor: "#d9f5e9",
              borderColor: "#2f9c70",
              textColor: "#146548",
            });
          }
        });
      }
    }
    for (const event of plan.fixedEvents) {
      events.push({
        id: event.id,
        title: event.title,
        start: event.start,
        end: event.end,
        backgroundColor: "#f1eafe",
        borderColor: "#a78bdf",
        textColor: "#5d3e92",
      });
    }
    return events;
  }, [calendarMode, plan, recommendation, selectionMap]);

  function updatePlan(next: Plan): void {
    setPlan(next);
    setRecommendation(null);
    setCalendarMode("options");
  }

  function addSubjectOption(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const cleanName = subjectName.trim();
    const label = optionLabel.trim() || "Group A";
    if (!cleanName || !selectedDays.length || timeToMinutes(classEnd) <= timeToMinutes(classStart)) {
      setNotice("Add a subject, choose at least one class day, and check the time range.");
      return;
    }
    const meeting: SlotMeeting = {
      days: [...selectedDays].sort((a, b) => a - b),
      start: classStart,
      end: classEnd,
    };
    const existing = plan.subjects.find((subject) => subject.name.toLowerCase() === cleanName.toLowerCase());
    const existingOption = existing?.options.find((option) => option.label.toLowerCase() === label.toLowerCase());
    if (existingOption && meetingHasOverlap(existingOption.meetings, meeting)) {
      setNotice(`This meeting overlaps another meeting already saved in ${label}. Choose a different time or another group.`);
      return;
    }

    let nextSubjects: Subject[];
    if (existing) {
      nextSubjects = plan.subjects.map((subject) => {
        if (subject.id !== existing.id) return subject;
        if (existingOption) {
          return { ...subject, importance, options: subject.options.map((option) => option.id === existingOption.id ? { ...option, meetings: [...option.meetings, meeting] } : option) };
        }
        const option: SlotOption = { id: makeId(), label, meetings: [meeting], preference: subject.options.length + 1 };
        return { ...subject, importance, options: [...subject.options, option] };
      });
    } else {
      nextSubjects = [...plan.subjects, { id: makeId(), name: cleanName, importance, options: [{ id: makeId(), label, meetings: [meeting], preference: 1 }] }];
    }
    updatePlan({ ...plan, subjects: nextSubjects });
    setSubjectName(cleanName);
    setOptionLabel(label);
    setNotice(`Added ${formatDays(meeting.days)} ${meeting.start}–${meeting.end} to ${cleanName} · ${label}.`);
  }

  function changeImportance(subjectId: string, value: number): void {
    updatePlan({
      ...plan,
      subjects: plan.subjects.map((subject) => subject.id === subjectId ? { ...subject, importance: value } : subject),
    });
  }

  function removeOption(subjectId: string, optionId: string): void {
    const subjects = plan.subjects
      .map((subject) => subject.id === subjectId ? { ...subject, options: subject.options.filter((option) => option.id !== optionId) } : subject)
      .filter((subject) => subject.options.length > 0);
    updatePlan({ ...plan, subjects });
  }

  function removeSubject(subjectId: string): void {
    updatePlan({ ...plan, subjects: plan.subjects.filter((subject) => subject.id !== subjectId) });
  }

  function addFixedEvent(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!fixedTitle.trim() || timeToMinutes(fixedEnd) <= timeToMinutes(fixedStart)) {
      setNotice("Enter a title and a valid start/end time.");
      return;
    }
    const fixed: FixedEvent = {
      id: makeId(),
      title: fixedTitle.trim(),
      start: `${fixedDate}T${fixedStart}:00`,
      end: `${fixedDate}T${fixedEnd}:00`,
    };
    updatePlan({ ...plan, fixedEvents: [...plan.fixedEvents, fixed] });
    setFixedTitle("");
    setShowFixedForm(false);
    setNotice("Fixed commitment added to the calendar.");
  }

  async function handleImport(file: File): Promise<void> {
    setIsImporting(true);
    setNotice("");
    try {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith(".ics")) {
        const events = readIcsEvents(text);
        if (!events.length) throw new Error("No timed calendar events were found in this ICS file.");
        if (importMode === "fixed") {
          const fixedEvents = events.flatMap((event) => {
            const duration = timeToMinutes(event.end) - timeToMinutes(event.start);
            const dates = event.recurring
              ? semesterDates(plan.semesterStart, plan.semesterEnd).filter((date) => dateKey(date) >= event.date && event.days.includes(date.getDay()))
              : [new Date(`${event.date}T12:00:00`)];
            return dates.map((date) => {
              const start = `${dateKey(date)}T${event.start}:00`;
              const endDate = new Date(`${dateKey(date)}T${event.start}:00`);
              endDate.setMinutes(endDate.getMinutes() + duration);
              const end = `${dateKey(endDate)}T${String(endDate.getHours()).padStart(2, "0")}:${String(endDate.getMinutes()).padStart(2, "0")}:00`;
              return { id: makeId(), title: event.summary, start, end };
            });
          });
          updatePlan({ ...plan, fixedEvents: [...plan.fixedEvents, ...fixedEvents] });
          setNotice(`Imported ${fixedEvents.length} fixed calendar event occurrence(s) from ${file.name}.`);
        } else {
          const groups = new Map<string, { subjectName: string; optionName: string; importance: number; meetings: SlotMeeting[] }>();
          events.forEach((event, eventIndex) => {
            const subjectNameFromFile = unescapeIcs(event.props["X-SUBJECT"] || event.summary);
            const customSection = event.props["X-SECTION"] ? unescapeIcs(event.props["X-SECTION"]) : "";
            const optionName = customSection || `Imported ${eventIndex + 1}`;
            const optionKey = customSection || event.props["UID"] || `event-${eventIndex + 1}`;
            const key = `${subjectNameFromFile.toLowerCase()}::${optionKey}`;
            const group = groups.get(key) || {
              subjectName: subjectNameFromFile,
              optionName,
              importance: parseImportance(event.props["X-IMPORTANCE"]),
              meetings: [],
            };
            const matchingMeeting = group.meetings.find((meeting) => meeting.start === event.start && meeting.end === event.end);
            if (matchingMeeting) {
              matchingMeeting.days = [...new Set([...matchingMeeting.days, ...event.days])].sort((a, b) => a - b);
            } else {
              group.meetings.push({ days: event.days, start: event.start, end: event.end });
            }
            groups.set(key, group);
          });
          let subjects = [...plan.subjects];
          for (const group of groups.values()) {
            if (!group.meetings.length) continue;
            const existing = subjects.find((subject) => subject.name.toLowerCase() === group.subjectName.toLowerCase());
            const existingOption = existing?.options.find((option) => option.label.toLowerCase() === group.optionName.toLowerCase());
            if (existing) {
              subjects = subjects.map((subject) => {
                if (subject.id !== existing.id) return subject;
                if (existingOption) {
                  const meetings = [...existingOption.meetings];
                  for (const meeting of group.meetings) {
                    const same = meetings.find((item) => item.start === meeting.start && item.end === meeting.end);
                    if (same) same.days = [...new Set([...same.days, ...meeting.days])].sort((a, b) => a - b);
                    else if (!meetingHasOverlap(meetings, meeting)) meetings.push(meeting);
                  }
                  return { ...subject, importance: group.importance, options: subject.options.map((option) => option.id === existingOption.id ? { ...option, meetings } : option) };
                }
                const option: SlotOption = { id: makeId(), label: group.optionName, meetings: group.meetings, preference: subject.options.length + 1 };
                return { ...subject, importance: group.importance, options: [...subject.options, option] };
              });
            } else {
              subjects.push({ id: makeId(), name: group.subjectName, importance: group.importance, options: [{ id: makeId(), label: group.optionName, meetings: group.meetings, preference: 1 }] });
            }
          }
          updatePlan({ ...plan, subjects });
          setNotice(`Imported ${groups.size} class option group(s) from ${file.name}. Review them before optimizing.`);
        }
      } else if (file.name.toLowerCase().endsWith(".csv")) {
        const rows = parseCsv(text);
        if (rows.length < 2) throw new Error("The CSV needs a header row and at least one data row.");
        const headers = rows[0].map((header) => header.trim().toLowerCase());
        const index = (name: string) => headers.indexOf(name);
        const get = (row: string[], name: string) => {
          const at = index(name);
          return at >= 0 ? (row[at] || "").trim() : "";
        };
        if (importMode === "fixed") {
          const fixedEvents = rows.slice(1).flatMap((row) => {
            const title = get(row, "title") || get(row, "subject");
            const date = get(row, "date");
            const start = get(row, "start");
            const end = get(row, "end");
            const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(`${date}T12:00:00`).getTime());
            const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(end) && timeToMinutes(end) > timeToMinutes(start);
            return title && validDate && validTime ? [{ id: makeId(), title, start: `${date}T${start}:00`, end: `${date}T${end}:00` }] : [];
          });
          if (!fixedEvents.length) throw new Error("For fixed-event CSV, use columns: title,date,start,end.");
          updatePlan({ ...plan, fixedEvents: [...plan.fixedEvents, ...fixedEvents] });
          setNotice(`Imported ${fixedEvents.length} fixed event(s) from ${file.name}.`);
        } else {
          const subjectRows = rows.slice(1).map((row) => ({
            name: get(row, "subject"),
            importance: parseImportance(get(row, "importance")),
            option: get(row, "option") || "Imported option",
            days: parseDays(get(row, "days") || get(row, "day")),
            start: get(row, "start"),
            end: get(row, "end"),
          })).filter((row) => row.name && row.days.length && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.start) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.end) && timeToMinutes(row.end) > timeToMinutes(row.start));
          if (!subjectRows.length) throw new Error("No valid class rows found. Use columns subject,importance,option,days,start,end, with times such as 09:00 and 10:30.");
          let subjects = [...plan.subjects];
          let skippedRows = 0;
          for (const row of subjectRows) {
            const existing = subjects.find((subject) => subject.name.toLowerCase() === row.name.toLowerCase());
            const meeting: SlotMeeting = { days: row.days, start: row.start, end: row.end };
            if (existing) {
              const existingOption = existing.options.find((option) => option.label.toLowerCase() === row.option.toLowerCase());
              subjects = subjects.map((subject) => {
                if (subject.id !== existing.id) return subject;
                if (!existingOption) {
                  const option: SlotOption = { id: makeId(), label: row.option, meetings: [meeting], preference: subject.options.length + 1 };
                  return { ...subject, importance: row.importance, options: [...subject.options, option] };
                }
                const duplicate = existingOption.meetings.some((item) => item.start === meeting.start && item.end === meeting.end && item.days.length === meeting.days.length && item.days.every((day) => meeting.days.includes(day)));
                if (duplicate || meetingHasOverlap(existingOption.meetings, meeting)) {
                  skippedRows += 1;
                  return subject;
                }
                return { ...subject, importance: row.importance, options: subject.options.map((option) => option.id === existingOption.id ? { ...option, meetings: [...option.meetings, meeting] } : option) };
              });
            } else {
              subjects.push({ id: makeId(), name: row.name, importance: row.importance, options: [{ id: makeId(), label: row.option, meetings: [meeting], preference: 1 }] });
            }
          }
          updatePlan({ ...plan, subjects });
          setNotice(`Imported ${subjectRows.length - skippedRows} class meeting row(s) from ${file.name}${skippedRows ? `; skipped ${skippedRows} duplicate or overlapping row(s).` : "."}`);
        }
      } else {
        throw new Error("Choose an .ics or .csv file.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not import this file.");
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function runOptimizer(): void {
    if (!plan.subjects.length) {
      setNotice("Add or import at least one subject before generating a schedule.");
      return;
    }
    if (plan.semesterEnd < plan.semesterStart) {
      setNotice("The semester end date must be after its start date.");
      return;
    }
    const result = optimizePlan(plan);
    setRecommendation(result);
    setCalendarMode("recommended");
    setNotice(result.missing.length
      ? `Added ${result.selections.length} subject recommendation(s). ${result.missing.length} subject(s) still need class options.`
      : result.conflicts.length
        ? "The best available combination still has conflicts. Review the warnings below."
        : "A conflict-free class combination has been generated.");
  }

  function changePreference(subjectId: string, optionId: string, direction: -1 | 1): void {
    const subjects = plan.subjects.map((subject) => {
      if (subject.id !== subjectId) return subject;
      const ordered = [...subject.options].sort((a, b) => a.preference - b.preference);
      const index = ordered.findIndex((option) => option.id === optionId);
      const target = index + direction;
      if (target < 0 || target >= ordered.length) return subject;
      [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
      return { ...subject, options: ordered.map((option, order) => ({ ...option, preference: order + 1 })) };
    });
    updatePlan({ ...plan, subjects });
  }

  function loadDemo(): void {
    const demo: Plan = {
      semesterStart: dateKey(new Date()),
      semesterEnd: dateKey(addDays(new Date(), 83)),
      subjects: [
        { id: "demo-algo", name: "Algorithms", importance: 5, options: [
          { id: "demo-algo-a", label: "Group A", meetings: [{ days: [1], start: "09:00", end: "10:30" }, { days: [3], start: "13:00", end: "14:30" }], preference: 1 },
          { id: "demo-algo-b", label: "Group B", meetings: [{ days: [2, 4], start: "13:00", end: "14:30" }], preference: 2 },
        ] },
        { id: "demo-db", name: "Database Systems", importance: 4, options: [
          { id: "demo-db-a", label: "Group A", meetings: [{ days: [1, 4], start: "11:00", end: "12:30" }], preference: 1 },
          { id: "demo-db-b", label: "Group B", meetings: [{ days: [2, 5], start: "09:00", end: "10:30" }], preference: 2 },
        ] },
        { id: "demo-net", name: "Computer Networks", importance: 3, options: [
          { id: "demo-net-a", label: "Group A", meetings: [{ days: [3, 5], start: "13:00", end: "14:30" }], preference: 1 },
          { id: "demo-net-b", label: "Group B", meetings: [{ days: [2, 4], start: "15:00", end: "16:30" }], preference: 2 },
        ] },
      ],
      fixedEvents: [{ id: "demo-work", title: "Part-time work", start: `${dateKey(addDays(new Date(), 1))}T16:00:00`, end: `${dateKey(addDays(new Date(), 1))}T18:00:00` }],
    };
    updatePlan(demo);
    setNotice("Demo subjects loaded. Press Confirm & optimize to see the planner work.");
  }

  function clearPlan(): void {
    const empty = defaultPlan();
    setPlan(empty);
    setRecommendation(null);
    setNotice("Your local plan has been cleared.");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark"><CalendarDays size={19} strokeWidth={2.2} /></div>
          <div>
            <div className="brand-name">campus<span>plan</span></div>
            <div className="brand-caption">SMART STUDY PLANNER</div>
          </div>
        </div>

        <div className="sidebar-scroll">
          <section className="setup-section">
            <div className="section-heading"><span>01</span><h2>Semester dates</h2></div>
            <div className="date-range-grid">
              <label>Starts<input type="date" value={plan.semesterStart} onChange={(event) => updatePlan({ ...plan, semesterStart: event.target.value })} /></label>
              <label>Ends<input type="date" value={plan.semesterEnd} onChange={(event) => updatePlan({ ...plan, semesterEnd: event.target.value })} /></label>
            </div>
          </section>

          <section className="setup-section import-section">
            <div className="section-heading"><span>02</span><h2>Import your timetable</h2></div>
            <p className="section-description">Bring in class options from your university or a spreadsheet you made.</p>
            <div className="import-mode" role="group" aria-label="Import type">
              <button className={importMode === "options" ? "active" : ""} onClick={() => setImportMode("options")}>Class options</button>
              <button className={importMode === "fixed" ? "active" : ""} onClick={() => setImportMode("fixed")}>Fixed events</button>
            </div>
            <button className="import-dropzone" onClick={() => fileInputRef.current?.click()} disabled={isImporting}>
              <span className="upload-icon"><FileUp size={20} /></span>
              <strong>{isImporting ? "Reading your file…" : "Choose an ICS or CSV file"}</strong>
              <small>Import {importMode === "options" ? "possible class groups and time slots" : "existing commitments and busy times"}</small>
            </button>
            <input ref={fileInputRef} className="visually-hidden" type="file" accept=".ics,.csv,text/calendar,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleImport(file); }} />
            <button className="template-link" onClick={downloadCsvTemplate}><ArrowDownToLine size={14} /> Download CSV example</button>
          </section>

          <section className="setup-section">
            <div className="section-heading"><span>03</span><h2>Subjects & class choices</h2></div>
            <p className="section-description">Add each subject and its possible groups. Reuse a group label to add another meeting to that same group.</p>
            <form className="subject-form" onSubmit={addSubjectOption}>
              <label>Subject name<input value={subjectName} onChange={(event) => setSubjectName(event.target.value)} placeholder="e.g. Data Structures" /></label>
              <label>Subject importance
                <select value={importance} onChange={(event) => setImportance(Number(event.target.value))}>
                  <option value={5}>5 · Essential</option>
                  <option value={4}>4 · Very important</option>
                  <option value={3}>3 · Normal</option>
                  <option value={2}>2 · Flexible</option>
                  <option value={1}>1 · Low priority</option>
                </select>
              </label>
              <div className="form-divider" />
              <label>Class group<input value={optionLabel} onChange={(event) => setOptionLabel(event.target.value)} placeholder="e.g. Group A" /></label>
              <div className="field-label">Available class days <span>Choose one or more</span></div>
              <div className="weekday-picker">
                {WEEKDAY_PICKER_ORDER.map((dayIndex) => (
                  <button key={dayIndex} type="button" aria-label={DAY_NAMES[dayIndex]} aria-pressed={selectedDays.includes(dayIndex)} className={selectedDays.includes(dayIndex) ? "selected" : ""} onClick={() => setSelectedDays((current) => current.includes(dayIndex) ? current.filter((item) => item !== dayIndex) : [...current, dayIndex].sort((a, b) => a - b))}>{DAY_SHORT[dayIndex].slice(0, 1)}</button>
                ))}
              </div>
              <div className="time-fields">
                <label>Starts<input type="time" value={classStart} onChange={(event) => setClassStart(event.target.value)} /></label>
                <label>Ends<input type="time" value={classEnd} onChange={(event) => setClassEnd(event.target.value)} /></label>
              </div>
              <button className="add-option-button" type="submit"><Plus size={16} /> Add class meeting</button>
            </form>

            <div className="subject-list">
              {plan.subjects.length === 0 ? (
                <div className="empty-subjects"><BookOpen size={19} /><span>No subjects yet</span><small>Import a file or add your first class above.</small></div>
              ) : plan.subjects.map((subject) => (
                <article className="subject-card" key={subject.id}>
                  <div className="subject-card-top">
                    <div className="subject-dot" />
                    <div className="subject-title-wrap"><strong>{subject.name}</strong><small>{subject.options.length} class option{subject.options.length === 1 ? "" : "s"}</small></div>
                    <label className="priority-inline"><span>Priority</span><select aria-label={`${subject.name} importance`} value={subject.importance} onChange={(event) => changeImportance(subject.id, Number(event.target.value))}><option value={5}>5</option><option value={4}>4</option><option value={3}>3</option><option value={2}>2</option><option value={1}>1</option></select></label>
                    <button className="icon-button subtle" aria-label={`Remove ${subject.name}`} onClick={() => removeSubject(subject.id)}><Trash2 size={14} /></button>
                  </div>
                  <div className="option-list">
                    {[...subject.options].sort((a, b) => a.preference - b.preference).map((option, index) => (
                      <div className="option-row" key={option.id}>
                        <div className="option-info"><span className="option-rank">{index + 1}</span><div><strong>{option.label}</strong><small>{formatMeetings(option.meetings)}</small></div></div>
                        <div className="option-actions">
                          <button className="icon-button" aria-label="Move option up" disabled={index === 0} onClick={() => changePreference(subject.id, option.id, -1)}><ChevronDown className="move-up" size={14} /></button>
                          <button className="icon-button" aria-label="Move option down" disabled={index === subject.options.length - 1} onClick={() => changePreference(subject.id, option.id, 1)}><ChevronDown size={14} /></button>
                          <button className="icon-button danger" aria-label={`Remove ${option.label}`} onClick={() => removeOption(subject.id, option.id)}><X size={14} /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="setup-section fixed-section">
            <div className="section-heading"><span>04</span><h2>Busy times</h2><button className="tiny-add" onClick={() => setShowFixedForm((value) => !value)}><Plus size={14} /> Add</button></div>
            <p className="section-description">Add work, appointments or other commitments the planner must avoid.</p>
            {showFixedForm && (
              <form className="fixed-form" onSubmit={addFixedEvent}>
                <label>What is it?<input value={fixedTitle} onChange={(event) => setFixedTitle(event.target.value)} placeholder="e.g. Part-time work" /></label>
                <label>Date<input type="date" value={fixedDate} onChange={(event) => setFixedDate(event.target.value)} /></label>
                <div className="time-fields"><label>Starts<input type="time" value={fixedStart} onChange={(event) => setFixedStart(event.target.value)} /></label><label>Ends<input type="time" value={fixedEnd} onChange={(event) => setFixedEnd(event.target.value)} /></label></div>
                <button className="add-option-button" type="submit"><Plus size={15} /> Save busy time</button>
              </form>
            )}
            {plan.fixedEvents.length === 0 ? <div className="muted-inline">No fixed commitments added.</div> : (
              <div className="fixed-list">{plan.fixedEvents.map((event) => <div className="fixed-item" key={event.id}><span className="fixed-dot" /><span>{event.title}<small>{event.start.slice(0, 10)} · {event.start.slice(11, 16)}–{event.end.slice(11, 16)}</small></span><button className="icon-button danger" aria-label={`Remove ${event.title}`} onClick={() => updatePlan({ ...plan, fixedEvents: plan.fixedEvents.filter((item) => item.id !== event.id) })}><X size={14} /></button></div>)}</div>
            )}
          </section>
        </div>

        <div className="sidebar-footer"><span className="local-indicator" /> Saved in this browser <button onClick={clearPlan}>Reset plan</button></div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div><div className="eyebrow">YOUR SEMESTER, ORGANIZED</div><h1>Build a timetable that <em>works for you.</em></h1><p>Compare class options, protect your free time, and let the planner find the best combination.</p></div>
          <div className="topbar-actions"><span className="local-ai-pill"><span /> LOCAL OPTIMIZER · NO API KEY</span><button className="demo-button" onClick={loadDemo}><RotateCcw size={15} /> Load demo</button></div>
        </header>

        <div className="metrics-row">
          <div className="metric-card"><span className="metric-icon blue"><BookOpen size={17} /></span><div><strong>{plan.subjects.length}</strong><small>Subjects</small></div></div>
          <div className="metric-card"><span className="metric-icon violet"><CalendarDays size={17} /></span><div><strong>{totalOptions}</strong><small>Class options</small></div></div>
          <div className="metric-card"><span className="metric-icon amber"><Clock3 size={17} /></span><div><strong>{plan.fixedEvents.length}</strong><small>Busy times</small></div></div>
          <div className="metric-card result-metric"><span className={`metric-icon ${recommendation && recommendation.conflicts.length === 0 ? "green" : "slate"}`}><Sparkles size={17} /></span><div><strong>{recommendation ? (recommendation.conflicts.length ? "Review" : "Ready") : "Not run"}</strong><small>Schedule status</small></div></div>
        </div>

        <section className="calendar-panel">
          <div className="calendar-toolbar">
            <div><div className="calendar-title-line"><h2>Semester calendar</h2><span className="calendar-period">{plan.semesterStart} — {plan.semesterEnd}</span></div><p>Every option is shown so you can compare clashes before confirming.</p></div>
            <div className="calendar-actions"><div className="view-switch"><button className={calendarMode === "options" ? "active" : ""} onClick={() => setCalendarMode("options")}>All options</button><button className={calendarMode === "recommended" ? "active" : ""} onClick={() => setCalendarMode("recommended")} disabled={!recommendation}>Best fit</button></div><button className="optimize-button" onClick={runOptimizer} disabled={!plan.subjects.length}><WandSparkles size={16} /> Confirm & optimize</button></div>
          </div>

          {notice && <div className="notice-line" role="status"><Info size={15} /><span>{notice}</span><button aria-label="Dismiss notice" onClick={() => setNotice("")}><X size={14} /></button></div>}

          <div className="calendar-legend"><span><i className="legend-dot option-dot" /> Available class options</span><span><i className="legend-dot selected-dot" /> Recommended option</span><span><i className="legend-dot fixed-legend-dot" /> Fixed commitment</span></div>

          <div className="calendar-wrap">
            <FullCalendar
              plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
              initialView="timeGridWeek"
              headerToolbar={{ left: "prev,next today", center: "title", right: "timeGridWeek,dayGridMonth" }}
              firstDay={1}
              events={calendarEvents as never[]}
              allDaySlot={false}
              slotMinTime="07:00:00"
              slotMaxTime="22:00:00"
              slotDuration="00:30:00"
              height="auto"
              nowIndicator
              dayMaxEvents
              eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
            />
          </div>

          {recommendation && (
            <div className="recommendation-panel">
              <div className="recommendation-heading"><div className="recommendation-symbol"><Sparkles size={18} /></div><div><h3>Your recommended timetable</h3><p>Best combination found from your available class groups and priorities.</p></div><span className={`recommendation-status ${recommendation.conflicts.length ? "warning" : "success"}`}>{recommendation.conflicts.length ? "Needs review" : "No clashes found"}</span></div>
              {recommendation.missing.length > 0 && <div className="warning-message"><AlertCircle size={16} /><span>Missing class options for: {recommendation.missing.join(", ")}. Add options to include these subjects.</span></div>}
              {recommendation.selections.length > 0 && <div className="recommended-list">{recommendation.selections.map((selection) => {
                const subject = plan.subjects.find((item) => item.id === selection.subjectId);
                const option = subject?.options.find((item) => item.id === selection.optionId);
                if (!subject || !option) return null;
                return <div className="recommended-row" key={selection.subjectId}><div className="recommended-check"><Check size={14} /></div><div className="recommended-name"><strong>{subject.name}</strong><small>Importance {subject.importance}/5</small></div><div className="recommended-slot"><strong>{option.label}</strong><small>{formatMeetings(option.meetings)}</small></div></div>;
              })}</div>}
              {recommendation.conflicts.length > 0 ? <div className="conflict-list"><strong><AlertCircle size={15} /> Conflicts to review</strong>{recommendation.conflicts.map((conflict) => <p key={conflict}>{conflict}</p>)}</div> : <div className="success-message"><CheckCircle2 size={16} /> The selected class groups do not overlap with one another or your fixed commitments.</div>}
              <div className="optimizer-footnote"><Info size={13} /> The local optimizer compares combinations, respects your subject importance and option ranking, and does not send your timetable to an external service.</div>
            </div>
          )}
        </section>

        {!recommendation && plan.subjects.length === 0 && (
          <div className="empty-workspace"><div className="empty-illustration"><CalendarDays size={27} /></div><div><h3>Your timetable starts here</h3><p>Import an ICS/CSV timetable or add a subject with two or more possible class groups. Then press <strong>Confirm & optimize</strong>.</p></div></div>
        )}
        <footer className="workspace-footer"><span>CampusPlan · Academic schedule optimizer</span><span><FileSpreadsheet size={13} /> ICS & CSV import supported</span></footer>
      </main>
    </div>
  );
}
