import { formatTime } from '../formatTime';

interface Props {
  positionSec: number;
  durationSec: number;
}

export function TimeDisplay({ positionSec, durationSec }: Props) {
  return (
    <span
      data-testid="time-display"
      className="text-xs tabular-nums text-muted"
    >
      {formatTime(positionSec)} / {formatTime(durationSec)}
    </span>
  );
}
