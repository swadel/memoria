import React from "react";

interface ProgressHeroProps {
  total: number;
  filed: number;
  needingReview: { images: number; dates: number };
  onAction: () => void;
}

export const ProgressHero: React.FC<ProgressHeroProps> = ({ total, filed, needingReview, onAction }) => {
  const percentage = total > 0 ? Math.round((filed / total) * 100) : 0;
  const strokeDasharray = 502.6;
  const strokeDashoffset = strokeDasharray - (strokeDasharray * percentage) / 100;

  return (
    <div className="relative overflow-hidden rounded-2xl bg-white p-10 shadow-paper border-none progressHeroRoot" data-testid="dashboard-progress-hero">
      <div className="flex flex-col items-center gap-12 md:flex-row progressHeroContent">
        <div className="relative flex h-48 w-48 items-center justify-center progressHeroRingWrap">
          <svg className="h-full w-full -rotate-90" aria-hidden="true">
            <defs>
              <linearGradient id="petalGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#93C5FD" />
                <stop offset="50%" stopColor="#C084FC" />
                <stop offset="100%" stopColor="#FDBA74" />
              </linearGradient>
            </defs>
            <circle cx="96" cy="96" r="80" className="fill-none stroke-slate-50" strokeWidth="10" />
            <circle
              cx="96"
              cy="96"
              r="80"
              className="fill-none transition-all duration-1000 ease-out"
              stroke="url(#petalGradient)"
              strokeWidth="12"
              strokeDasharray={strokeDasharray}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center progressHeroPercent">
            <span className="text-4xl font-bold text-slate-800">{percentage}%</span>
            <span className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Filed</span>
          </div>
        </div>

        <div className="flex-1 space-y-5 text-center md:text-left progressHeroBody">
          <h2 className="text-4xl font-semibold tracking-tight text-slate-900 leading-tight progressHeroHeading" data-testid="dashboard-progress-copy">
            You’ve organized <span className="text-petal-blue">{filed}</span> of {total} items.
          </h2>
          <p className="text-xl text-slate-500 font-medium progressHeroSubtext">
            {needingReview.images > 0 && `${needingReview.images} images `}
            {needingReview.images > 0 && needingReview.dates > 0 && "& "}
            {needingReview.dates > 0 && `${needingReview.dates} dates `}
            ready for review.
          </p>
          <button
            onClick={onAction}
            className="rounded-full bg-petal-blue px-10 py-4 font-bold text-white shadow-lg transition-all hover:bg-blue-400 hover:-translate-y-1 active:scale-95 progressHeroButton"
          >
            Resume Organizing
          </button>
        </div>
      </div>
    </div>
  );
};
