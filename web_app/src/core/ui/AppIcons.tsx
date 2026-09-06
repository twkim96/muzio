import { ArrowsDownUp } from '@phosphor-icons/react/dist/csr/ArrowsDownUp';
import { ArrowSquareOut } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { DotsThree } from '@phosphor-icons/react/dist/csr/DotsThree';
import { Heart } from '@phosphor-icons/react/dist/csr/Heart';
import { Image } from '@phosphor-icons/react/dist/csr/Image';
import { ListChecks } from '@phosphor-icons/react/dist/csr/ListChecks';
import { MusicNotesSimple } from '@phosphor-icons/react/dist/csr/MusicNotesSimple';
import { Queue } from '@phosphor-icons/react/dist/csr/Queue';
import { Repeat } from '@phosphor-icons/react/dist/csr/Repeat';
import { Shuffle } from '@phosphor-icons/react/dist/csr/Shuffle';
import { ShareNetwork } from '@phosphor-icons/react/dist/csr/ShareNetwork';
import { SpeakerHigh } from '@phosphor-icons/react/dist/csr/SpeakerHigh';
import { SpeakerX } from '@phosphor-icons/react/dist/csr/SpeakerX';
import { Timer } from '@phosphor-icons/react/dist/csr/Timer';
import { Video } from '@phosphor-icons/react/dist/csr/Video';
import { X } from '@phosphor-icons/react/dist/csr/X';
import type { ReactNode } from 'react';
import type {
  Icon as PhosphorIcon,
  IconWeight,
} from '@phosphor-icons/react/dist/lib/types';

interface IconProps {
  className?: string;
}

function AppIcon({
  icon: Icon,
  className = 'h-6 w-6',
  weight = 'light',
}: IconProps & {
  icon: PhosphorIcon;
  weight?: IconWeight;
}) {
  return (
    <Icon
      aria-hidden
      className={className}
      weight={weight}
    />
  );
}

export function DownChevronIcon(props: IconProps) {
  return <AppIcon icon={CaretDown} {...props} />;
}

export function PlayGlyph(props: IconProps) {
  return (
    <TransportSvg {...props}>
      <path d="M90 55.5c0-7.7 8.5-12.3 15-8.1l109.5 70.5c6.1 3.9 6.1 12.8 0 16.7L105 205.1c-6.5 4.2-15-.4-15-8.1V55.5Z" />
    </TransportSvg>
  );
}

export function PauseGlyph(props: IconProps) {
  return (
    <TransportSvg {...props}>
      <rect x="76" y="50" width="32" height="156" rx="11" />
      <rect x="148" y="50" width="32" height="156" rx="11" />
    </TransportSvg>
  );
}

export function SkipGlyph({
  direction,
  ...props
}: IconProps & {
  direction: 'back' | 'forward';
}) {
  return (
    <TransportSvg {...props}>
      {direction === 'back' ? (
        <>
          <rect x="54" y="67" width="12" height="122" rx="6" />
          <path d="M194 61.7c0-7.8-8.9-12.3-15.3-7.7L84.5 120.3c-5.4 3.8-5.4 11.8 0 15.6l94.2 66.3c6.4 4.5 15.3 0 15.3-7.7V61.7Z" />
        </>
      ) : (
        <>
          <path d="M62 61.7c0-7.8 8.9-12.3 15.3-7.7l94.2 66.3c5.4 3.8 5.4 11.8 0 15.6l-94.2 66.3c-6.4 4.5-15.3 0-15.3-7.7V61.7Z" />
          <rect x="190" y="67" width="12" height="122" rx="6" />
        </>
      )}
    </TransportSvg>
  );
}

function TransportSvg({
  className = 'h-6 w-6',
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      aria-hidden
      className={className}
      viewBox="0 0 256 256"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

export function SleepTimerGlyph(props: IconProps) {
  return <AppIcon icon={Timer} {...props} />;
}

export function MusicGlyph(props: IconProps) {
  return <AppIcon icon={MusicNotesSimple} {...props} />;
}

export function VideoGlyph(props: IconProps) {
  return <AppIcon icon={Video} {...props} />;
}

export function OpenExternalGlyph(props: IconProps) {
  return <AppIcon icon={ArrowSquareOut} {...props} />;
}

export function ShareGlyph(props: IconProps) {
  return <AppIcon icon={ShareNetwork} {...props} />;
}

export function ImageGlyph(props: IconProps) {
  return <AppIcon icon={Image} {...props} />;
}

export function TheaterGlyph({
  active = false,
  className = 'h-6 w-6',
}: IconProps & { active?: boolean }) {
  return (
    <svg
      aria-hidden
      className={className}
      viewBox="0 0 256 256"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="48"
        y="56"
        width="160"
        height="112"
        rx="12"
        stroke="currentColor"
        strokeWidth="18"
      />
      <path
        d="M88 196h80"
        stroke="currentColor"
        strokeWidth="18"
        strokeLinecap="round"
      />
      <path
        d="M128 168v28"
        stroke="currentColor"
        strokeWidth="18"
        strokeLinecap="round"
      />
      {active ? (
        <>
          <path
            d="M88 112h42"
            stroke="currentColor"
            strokeWidth="18"
            strokeLinecap="round"
          />
          <path
            d="M104 90 82 112l22 22"
            stroke="currentColor"
            strokeWidth="18"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M168 112h-42"
            stroke="currentColor"
            strokeWidth="18"
            strokeLinecap="round"
          />
          <path
            d="M152 90l22 22-22 22"
            stroke="currentColor"
            strokeWidth="18"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <path
            d="M116 112H76"
            stroke="currentColor"
            strokeWidth="18"
            strokeLinecap="round"
          />
          <path
            d="M94 90 72 112l22 22"
            stroke="currentColor"
            strokeWidth="18"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M140 112h40"
            stroke="currentColor"
            strokeWidth="18"
            strokeLinecap="round"
          />
          <path
            d="M162 90l22 22-22 22"
            stroke="currentColor"
            strokeWidth="18"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}

export function LikeGlyph({
  liked = false,
  ...props
}: IconProps & { liked?: boolean }) {
  return <AppIcon icon={Heart} weight={liked ? 'fill' : 'light'} {...props} />;
}

export function VolumeGlyph({
  muted = false,
  ...props
}: IconProps & { muted?: boolean }) {
  return <AppIcon icon={muted ? SpeakerX : SpeakerHigh} {...props} />;
}

export function QueueGlyph(props: IconProps) {
  return <AppIcon icon={Queue} {...props} />;
}

export function MoreGlyph(props: IconProps) {
  return <AppIcon icon={DotsThree} {...props} />;
}

export function StopAfterCurrentGlyph(props: IconProps) {
  return <AppIcon icon={ListChecks} {...props} />;
}

export function ShuffleGlyph(props: IconProps) {
  return <AppIcon icon={Shuffle} {...props} />;
}

export function RepeatGlyph(props: IconProps) {
  return <AppIcon icon={Repeat} {...props} />;
}

export function RepeatOneGlyph({ className = 'h-6 w-6' }: IconProps) {
  return (
    <span
      aria-hidden
      className={`relative inline-flex items-center justify-center ${className}`}
    >
      <RepeatGlyph className="h-full w-full" />
      <span
        data-testid="repeat-one-glyph"
        className="absolute inset-0 flex items-center justify-center text-[0.38em] font-semibold leading-none"
      >
        1
      </span>
    </span>
  );
}

export function CloseGlyph(props: IconProps) {
  return <AppIcon icon={X} {...props} />;
}

export function SortGlyph(props: IconProps) {
  return <AppIcon icon={ArrowsDownUp} {...props} />;
}
