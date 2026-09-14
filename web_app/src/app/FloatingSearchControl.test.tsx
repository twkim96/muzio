import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { FloatingSearchControl } from './FloatingSearchControl';

it('opens and focuses artist search requests, and can reopen after dismissal', () => {
  const onQueryChange = vi.fn();
  const view = render(<FloatingSearchControl title="Music" query="" onQueryChange={onQueryChange} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(<FloatingSearchControl title="Music" query="" onQueryChange={onQueryChange} openRequest="first-artist" />);
  expect(screen.getByRole('dialog', { name: 'Music search' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Filter Music' })).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(<FloatingSearchControl title="Music" query="" onQueryChange={onQueryChange} openRequest="next-artist" />);
  expect(screen.getByRole('textbox', { name: 'Filter Music' })).toHaveFocus();
});

it('closes inline search with X or outside pointer without clearing the query', () => {
  const change = vi.fn();
  render(<FloatingSearchControl title="Video" query="saved" onQueryChange={change} />);
  fireEvent.click(screen.getByLabelText('Search Video'));
  expect(screen.getByLabelText('Filter Video')).toHaveValue('saved');
  fireEvent.click(screen.getByLabelText('Close Video search'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Search Video'));
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(change).not.toHaveBeenCalled();
});
