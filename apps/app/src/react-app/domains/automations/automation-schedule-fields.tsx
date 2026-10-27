/** @jsxImportSource react */
import type { AutomationSchedule } from "@openwork/types/automations"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useOrgFeature } from "@/react-app/domains/cloud/use-org-feature"

const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
] as const

function tomorrowAtNine() {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  date.setHours(9, 0, 0, 0)
  return date.getTime()
}

function toLocalDateTime(value: number) {
  const date = new Date(value)
  const component = (part: number) => String(part).padStart(2, "0")
  return `${date.getFullYear()}-${component(date.getMonth() + 1)}-${component(date.getDate())}T${component(date.getHours())}:${component(date.getMinutes())}`
}

function timeForSchedule(schedule: AutomationSchedule) {
  if (schedule.kind === "once") return { hour: 9, minute: 0 }
  if (schedule.kind === "interval") return { hour: schedule.startHour, minute: 0 }
  return { hour: schedule.hour, minute: schedule.minute }
}

const INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12] as const
const SELECT_CLASS = "h-9 w-full rounded-lg border border-border bg-background px-3 text-sm"
const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`

/**
 * Frequency, time, days and time zone of an Automation schedule. Shared by the
 * full Automation editor and the Calendar's "Edit schedule" dialog so both
 * edit schedules the same way.
 */
export function AutomationScheduleFields(props: {
  schedule: AutomationSchedule
  onChange: (schedule: AutomationSchedule) => void
  /** Prefix for element ids, so two editors can share a page. */
  idPrefix?: string
}) {
  const id = (name: string) => `${props.idPrefix ?? "automation"}-${name}`
  const schedule = props.schedule
  const time = timeForSchedule(schedule)
  // An Automation that already repeats every few hours keeps the choice even if the feature is turned off.
  const intervalOffered = useOrgFeature("automationIntervalSchedules") || schedule.kind === "interval"

  const changeScheduleKind = (kind: AutomationSchedule["kind"]) => {
    const timezone = schedule.timezone
    const days = schedule.kind === "weekly" || schedule.kind === "interval" ? schedule.daysOfWeek : [1, 2, 3, 4, 5]
    if (kind === "once") return props.onChange({ kind, timezone, at: tomorrowAtNine() })
    if (kind === "daily") return props.onChange({ kind, timezone, hour: time.hour, minute: time.minute })
    if (kind === "interval") return props.onChange({ kind, timezone, everyHours: 3, daysOfWeek: days, startHour: 9, endHour: 18 })
    props.onChange({ kind, timezone, daysOfWeek: days, hour: time.hour, minute: time.minute })
  }

  const changeTime = (value: string) => {
    const [hour, minute] = value.split(":").map(Number)
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || (schedule.kind !== "daily" && schedule.kind !== "weekly")) return
    props.onChange({ ...schedule, hour, minute })
  }

  const toggleWeekday = (day: number) => {
    if (schedule.kind !== "weekly" && schedule.kind !== "interval") return
    const selected = schedule.daysOfWeek.includes(day)
    const daysOfWeek = selected
      ? schedule.daysOfWeek.filter((value) => value !== day)
      : [...schedule.daysOfWeek, day].sort((left, right) => left - right)
    if (daysOfWeek.length === 0) return
    props.onChange({ ...schedule, daysOfWeek })
  }

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={id("frequency")}>Schedule</Label>
          <select
            id={id("frequency")}
            className={SELECT_CLASS}
            value={schedule.kind}
            onChange={(event) => {
              const kind = event.currentTarget.value
              if (kind === "once" || kind === "daily" || kind === "weekly" || kind === "interval") changeScheduleKind(kind)
            }}
          >
            <option value="once">Once</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            {intervalOffered ? <option value="interval">Every few hours</option> : null}
          </select>
        </div>
        {schedule.kind === "interval" ? (
          <div className="space-y-2">
            <Label htmlFor={id("every-hours")}>Every</Label>
            <select
              id={id("every-hours")}
              className={SELECT_CLASS}
              value={schedule.everyHours}
              onChange={(event) => props.onChange({ ...schedule, everyHours: Number(event.currentTarget.value) })}
            >
              {[...new Set([...INTERVAL_HOURS, schedule.everyHours])].sort((left, right) => left - right).map((hours) => (
                <option key={hours} value={hours}>{hours === 1 ? "1 hour" : `${hours} hours`}</option>
              ))}
            </select>
          </div>
        ) : schedule.kind === "once" ? (
          <div className="space-y-2">
            <Label htmlFor={id("once-at")}>Run at</Label>
            <Input
              id={id("once-at")}
              type="datetime-local"
              value={toLocalDateTime(schedule.at)}
              onChange={(event) => {
                const at = new Date(event.currentTarget.value).getTime()
                if (Number.isFinite(at)) props.onChange({ kind: "once", timezone: schedule.timezone, at })
              }}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor={id("time")}>Time</Label>
            <Input
              id={id("time")}
              type="time"
              value={`${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`}
              onChange={(event) => changeTime(event.currentTarget.value)}
            />
          </div>
        )}
      </div>

      {schedule.kind === "interval" ? (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={id("window-start")}>From</Label>
            <select
              id={id("window-start")}
              className={SELECT_CLASS}
              value={schedule.startHour}
              onChange={(event) => {
                const startHour = Number(event.currentTarget.value)
                props.onChange({ ...schedule, startHour, endHour: Math.max(schedule.endHour, startHour + 1) })
              }}
            >
              {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={id("window-end")}>Until</Label>
            <select
              id={id("window-end")}
              className={SELECT_CLASS}
              value={schedule.endHour}
              onChange={(event) => props.onChange({ ...schedule, endHour: Number(event.currentTarget.value) })}
            >
              {Array.from({ length: 24 - schedule.startHour }, (_, index) => schedule.startHour + index + 1).map((hour) => (
                <option key={hour} value={hour}>{hour === 24 ? "End of day" : hourLabel(hour)}</option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {schedule.kind === "weekly" || schedule.kind === "interval" ? (
        <div className="space-y-2">
          <Label>Days</Label>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map((day) => (
              <Button
                key={day.value}
                type="button"
                size="sm"
                variant={schedule.daysOfWeek.includes(day.value) ? "secondary" : "outline"}
                onClick={() => toggleWeekday(day.value)}
              >
                {day.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}

/** The time zone input, kept separate so the full editor can pair it with the model picker. */
export function AutomationTimezoneField(props: {
  timezone: string
  onChange: (timezone: string) => void
  idPrefix?: string
}) {
  const id = `${props.idPrefix ?? "automation"}-timezone`
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Timezone</Label>
      <Input id={id} value={props.timezone} onChange={(event) => props.onChange(event.currentTarget.value)} />
    </div>
  )
}
