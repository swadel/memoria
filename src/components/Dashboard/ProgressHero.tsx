import React from "react";
import { motion } from "framer-motion";
import logoImage from "../../assets/logo.png";

interface ProgressHeroProps {
  total: number;
  filed: number;
  needingReview: { images: number; dates: number };
  onAction: () => void;
}

export const ProgressHero: React.FC<ProgressHeroProps> = ({ total, filed, needingReview, onAction }) => {
  const percentage = total > 0 ? Math.round((filed / total) * 100) : 0;
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;

  return (
    <div className="relative overflow-hidden rounded-2xl bg-white p-8 shadow-paper progressHeroRoot" data-testid="dashboard-progress-hero">
      <div className="flex flex-col items-center gap-8 md:flex-row progressHeroContent">
        <div className="relative flex h-40 w-40 items-center justify-center progressHeroRingWrap">
          <svg className="h-full w-full -rotate-90">
            <circle cx="80" cy="80" r={radius} className="fill-none stroke-slate-100" strokeWidth="12" />
            <circle
              cx="80"
              cy="80"
              r={radius}
              className="fill-none stroke-petal-blue transition-all duration-1000 ease-out"
              strokeWidth="12"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              strokeLinecap="round"
            />
          </svg>
          <div className="absolute flex flex-col items-center progressHeroPercent">
            <span className="text-3xl font-bold text-slate-800">{percentage}%</span>
            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Filed</span>
          </div>
        </div>

        <div className="flex-1 space-y-4 text-center md:text-left progressHeroBody">
          <div className="progressHeroIcon" aria-hidden="true">
            <img src={logoImage} alt="" className="progressHeroIconImage" />
          </div>
          <h2 className="text-3xl font-semibold tracking-tight text-slate-900 progressHeroHeading" data-testid="dashboard-progress-copy">
            You’ve organized {filed} of {total} items.
          </h2>
          <p className="text-lg text-slate-600 progressHeroSubtext">
            {needingReview.images > 0 && `You have ${needingReview.images} images `}
            {needingReview.images > 0 && needingReview.dates > 0 && "and "}
            {needingReview.dates > 0 && `${needingReview.dates} dates `}
            ready for your review.
          </p>
          <motion.button
            onClick={onAction}
            className="rounded-full bg-petal-blue px-8 py-3 font-semibold text-white shadow-lg transition-all hover:bg-blue-400 hover:shadow-xl active:scale-95 progressHeroButton"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            Resume Organizing
          </motion.button>
        </div>
      </div>
    </div>
  );
};
