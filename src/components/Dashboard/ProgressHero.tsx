import React from "react";
import logoImage from "../../assets/flower_1024.png";

interface ProgressHeroProps {
  total: number;
  filed: number;
  needingReview: { images: number; dates: number };
  previewThumbnails?: string[];
  progressPercent?: number;
  onAction: () => void;
}

export const ProgressHero: React.FC<ProgressHeroProps> = ({
  total,
  filed,
  needingReview,
  previewThumbnails = [],
  progressPercent,
  onAction
}) => {
  const percentage = total > 0 ? Math.round((filed / total) * 100) : 0;
  const edgeProgress = Math.max(0, Math.min(100, progressPercent ?? percentage));
  const isComplete = total > 0 && filed >= total;
  const visibleThumbs = previewThumbnails.slice(0, 3);

  return (
    <div className="relative overflow-hidden rounded-3xl bg-white p-10 shadow-paper border-none progressHeroRoot" data-testid="dashboard-progress-hero">
      <div className="flex flex-col items-center gap-10 md:flex-row progressHeroContent">
        <div className="progressHeroMemoryStack" data-testid="progress-memory-stack">
          {visibleThumbs.length > 0 ? (
            visibleThumbs.map((src, index) => (
              <img
                key={`${src}-${index}`}
                src={src}
                alt=""
                aria-hidden="true"
                className={`progressHeroMemoryCard progressHeroMemoryCard${index + 1}`}
              />
            ))
          ) : (
            <div className="progressHeroFallback">
              <img src={logoImage} alt="" aria-hidden="true" className="progressHeroFallbackLogo animate-pulse" data-testid="progress-hero-fallback-logo" />
            </div>
          )}
        </div>

        <div className="flex-1 space-y-5 text-center md:text-left progressHeroBody">
          <h2 className="text-4xl font-semibold tracking-tight text-slate-900 leading-tight progressHeroHeading" data-testid="dashboard-progress-copy">
            {isComplete ? "Your archive is fully organized!" : `You've filed ${filed} of ${total} items.`}
          </h2>
          <p className="text-xl text-slate-500 font-medium progressHeroSubtext">
            {needingReview.images} images ready for review.
          </p>
          <button
            onClick={onAction}
            className="rounded-full bg-petal-blue px-10 py-4 font-bold text-white shadow-lg transition-all hover:bg-blue-400 hover:-translate-y-1 active:scale-95 progressHeroButton"
          >
            Resume Organizing
          </button>
        </div>
      </div>
      <div className="progressHeroEdgeBarTrack" aria-hidden="true">
        <div className="progressHeroEdgeBarFill" data-testid="progress-hero-edge-fill" style={{ width: `${edgeProgress}%` }} />
      </div>
    </div>
  );
};
