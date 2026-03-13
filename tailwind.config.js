/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        "petal-blue": "#93C5FD",
        "petal-orange": "#FDBA74",
        "petal-purple": "#C084FC"
      },
      fontFamily: {
        sans: ["Segoe UI Variable", "Inter", "Segoe UI", "system-ui", "sans-serif"]
      },
      borderRadius: {
        xl: "0.75rem",
        "2xl": "1rem"
      }
    }
  },
  plugins: []
};
