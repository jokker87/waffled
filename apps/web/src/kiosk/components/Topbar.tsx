import { useEffect, useRef, useState } from 'react'
import { useTopbarSlots } from '../topbar-slot'
import { useHousehold, useWeather, type Weather } from '../../lib/api'
import { applyEventStyle, eventStyle } from '../../lib/display'
import { CaptureBar } from './CaptureBar'
import { useI18n } from '../../lib/locale-provider'

// Weather widget with a hover/tap popover that says where the reading comes from.
function WeatherWidget({ wx }: { wx: Weather }) {
  const { t, language, formatNumber } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [open])
  const temperature = language === 'en' ? wx.tempF! : Math.round((wx.tempF! - 32) * 5 / 9)
  const unit = language === 'en' ? 'F' : 'C'
  return (
    <div className="tb-wx-wrap" ref={ref}>
      <button
        type="button"
        className="tb-wx"
        aria-label={t('topbar.weatherDetails')}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        <span aria-hidden="true">{wx.emoji}</span>
        {formatNumber(temperature)}°{unit}
      </button>
      <div className={`tb-wx-pop ${open ? 'open' : ''}`} role="tooltip">
        <div className="tb-wx-pop-t">
          {wx.emoji} {formatNumber(temperature)}°{unit}{wx.label ? ` · ${wx.label}` : ''}
        </div>
        <div className="tb-wx-pop-s">{wx.location ? t('topbar.weatherFor', { location: wx.location }) : t('topbar.weather')}</div>
        <div className="tb-wx-pop-s muted">{t('topbar.weatherSource')}</div>
      </div>
    </div>
  )
}

function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

function formatTime(d: Date, locale: string, tz?: string): string {
  return d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined })
}

export function Topbar() {
  const { locale, formatDate } = useI18n()
  const now = useNow()
  const { right, full } = useTopbarSlots()
  const { household } = useHousehold()
  const wx = useWeather()
  const tz = household?.timezone
  // The topbar is the one piece of chrome on every kiosk screen that already
  // reads the household, so it also stamps the event style onto <html> for the
  // calendar's CSS. useHousehold re-fetches on the household-changed event, so
  // flipping the setting in Settings restyles every open surface immediately —
  // no separate sync component needed.
  useEffect(() => applyEventStyle(eventStyle(household)), [household])
  if (full) return <div className="topbar">{full}</div>
  return (
    <div className="topbar">
      <div className="tb-date wf-serif">{formatDate(now, { weekday: 'short', month: 'long', day: 'numeric', timeZone: tz || undefined })}</div>
      <div className="tb-time">{formatTime(now, locale, tz)}</div>
      {wx?.configured && wx.tempF != null && <WeatherWidget wx={wx} />}
      <div className="tb-right">{right ?? <CaptureBar />}</div>
    </div>
  )
}
