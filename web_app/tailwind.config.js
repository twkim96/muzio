/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Apple-inspired accent. Tones use CSS variables so light/dark and the
      // future reduced-effects glass mode can flip values without rebuilding
      // the Tailwind palette.
      colors: {
        accent: 'rgb(var(--accent) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        foreground: 'rgb(var(--foreground) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
      },
    },
  },
  plugins: [],
};
