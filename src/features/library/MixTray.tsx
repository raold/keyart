import { motion, useReducedMotion } from 'framer-motion'
import { AlertCircle, CalendarClock, Check, Info, Loader2, Upload } from 'lucide-react'
import type { ArtGroup } from '../../../electron/services/scheduleUtils'
import Button from '../../components/ui/Button'
import type { ApplyState } from '../../utils/applyPosters'
import styles from './LibraryPage.module.css'

/** One art group of a show as the mix would leave it. */
export interface MixSlot {
  group: ArtGroup
  /** The group's name on screen. */
  label: string
  /** A poster from the set filling the group, if one is known. */
  thumb?: string
  /** Who made the art filling the group; undefined while Plex's own art stays. */
  creator?: string
  /** Apply mix would replace what the show has for this group now. */
  change: boolean
}

/** Groups whose art is landscape; the others are portrait posters. */
const WIDE_GROUPS: ArtGroup[] = ['cards', 'backdrop']

/**
 * The tray under a show's sets that holds the groups picked from different
 * sets and applies them together. Each slot is drawn in the shape of the art
 * it holds, so the row reads as a small preview of the show.
 *
 * @param props.slots - One slot per group the show's sets offer, in display order.
 * @param props.note - A caveat about the result, such as seasons the picked set lacks.
 * @param props.apply - Progress and outcome of the last Apply mix.
 * @param props.disabled - Apply mix has nothing to change or another apply is running.
 * @param props.onApply - Applies the picked groups.
 * @param props.onClear - Drops every pick and closes the tray.
 * @param props.cardsHint - Shown when no job keeps the title cards' set up to date.
 */
export default function MixTray({ slots, note, apply, disabled, onApply, onClear, cardsHint }: {
  slots: MixSlot[]
  note?: string
  apply?: ApplyState
  disabled: boolean
  onApply: () => void
  onClear: () => void
  cardsHint?: { creator: string; onSchedule: () => void }
}) {
  const reduceMotion = useReducedMotion()
  const applying = apply?.status === 'applying'
  const offset = reduceMotion ? 0 : 16

  return (
    <motion.section
      className={styles.mixTray}
      aria-label="Your mix"
      initial={{ opacity: 0, y: offset }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: offset }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
    >
      {applying && (
        <div
          className={styles.mixProgress}
          role="progressbar"
          aria-label="Applying mix"
          aria-valuemin={0}
          aria-valuemax={apply.total}
          aria-valuenow={apply.done}
        >
          <span style={{ width: `${apply.total ? (apply.done / apply.total) * 100 : 0}%` }} />
        </div>
      )}

      <div className={styles.mixHead}>
        <h3 className={styles.mixTitle}>Your mix</h3>
        {!applying && !apply?.error && !slots.some(s => s.change) && (
          <span className={styles.mixSummary}>Your picks are already on the show</span>
        )}
        <div className={styles.mixActions}>
          <Button variant="ghost" size="sm" onClick={onClear} disabled={applying}>Clear</Button>
          {applying
            ? <span className={styles.applyProgress}><Loader2 size={13} className={styles.spin} /> Applying mix {apply.done}/{apply.total}</span>
            : <Button variant="primary" size="sm" icon={<Upload size={12} />} onClick={onApply} disabled={disabled}>Apply mix</Button>}
        </div>
      </div>

      <ul className={styles.mixSlots}>
        {slots.map(s => (
          <li key={s.group} className={`${styles.mixSlot} ${s.change ? styles.mixSlotChange : ''} ${s.creator ? '' : styles.mixSlotDefault}`}>
            <div className={styles.mixFrame} aria-hidden="true">
              <div className={[
                styles.mixThumb,
                WIDE_GROUPS.includes(s.group) ? styles.mixThumbWide : '',
                s.group === 'seasons' ? styles.mixThumbStack : '',
                s.thumb ? '' : styles.mixThumbEmpty,
              ].filter(Boolean).join(' ')}>
                {s.thumb && <img src={s.thumb} alt="" loading="lazy" draggable={false} />}
              </div>
            </div>
            <div className={styles.mixSlotText}>
              <span className={styles.mixSlotLabel}>{s.label}</span>
              <span className={styles.mixSlotCreator} title={s.creator}>{s.creator ?? 'Plex default'}</span>
              {s.creator && <span className={styles.mixSlotState}>{s.change ? 'New' : 'Current'}</span>}
            </div>
          </li>
        ))}
      </ul>

      {note && (
        <p className={styles.mixNote}><Info size={12} /><span>{note}</span></p>
      )}
      {cardsHint && (
        <p className={styles.mixNote}>
          <Info size={12} />
          <span>New episodes won&apos;t get title cards until {cardsHint.creator}&apos;s set is scheduled.</span>
          <button className={styles.scheduleBtn} onClick={cardsHint.onSchedule}>
            <CalendarClock size={12} /> Schedule
          </button>
        </p>
      )}

      {apply?.status === 'done' && (
        <p className={`${styles.applyDone} ${styles.mixResult}`} role="status">
          <Check size={13} /> Applied {apply.done}{apply.error ? ` · ${apply.error}` : ''}
        </p>
      )}
      {apply?.status === 'error' && (
        <p className={`${styles.applyError} ${styles.mixResult}`} role="alert">
          <AlertCircle size={13} /> {apply.error ?? 'Failed'}
        </p>
      )}
    </motion.section>
  )
}
