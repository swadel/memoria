/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Branding colors derived from your flower logo
        petal: {
          blue: "#93C5FD",   // Sky/Petal Blue
          orange: "#FDBA74", // Soft Petal Orange
          purple: "#C084FC", // Light Petal Purple
          pink: "#F9A8D4",   // Soft Petal Pink
        },
        // Windows 11 & Apple-inspired background tones
        background: {
          mica: "rgba(255, 255, 255, 0.7)", // For use with backdrop-blur
          canvas: "#F9FAFB",                // Soft grey page background
        },
        // Standardizing shadcn/ui primary to your logo blue
        primary: {
          DEFAULT: "#93C5FD",
          foreground: "#FFFFFF",
        },
      },
      fontFamily: {
        // Prioritizing the modern Windows 11 variable font
        sans: ["Segoe UI Variable", "Inter", "Segoe UI", "system-ui", "sans-serif"],
      },
      letterSpacing: {
        // Used for the "Memoria" brand text style
        tighter: "-0.05em", 
      },
      borderRadius: {
        // Softer, premium corners
        xl: "0.75rem",
        "2xl": "1rem",
      },
      boxShadow: {
        // Custom shadows to define sections instead of using borders
        'paper': '0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px 0 rgba(0, 0, 0, 0.03)',
        'paper-hover': '0 10px 20px -5px rgba(0, 0, 0, 0.08), 0 8px 8px -5px rgba(0, 0, 0, 0.04)',
      },
    },
  },
  plugins: [
    // Required for shadcn/ui animations and your fade-in transitions
    require("tailwindcss-animate"),
  ],
};