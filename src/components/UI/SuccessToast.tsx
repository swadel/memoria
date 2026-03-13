import React, { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import logo from "../../assets/logo.png";

export const SuccessToast: React.FC<{ show: boolean; onClose: () => void }> = ({ show, onClose }) => {
  useEffect(() => {
    if (show) {
      const timer = setTimeout(() => {
        onClose();
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [show, onClose]);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 50, scale: 0.9, x: "-50%" }}
          animate={{ opacity: 1, y: 0, scale: 1, x: "-50%" }}
          exit={{ opacity: 0, scale: 0.9, y: 20, transition: { duration: 0.2 } }}
          className="fixed bottom-10 left-1/2 z-[100] flex items-center gap-4 rounded-2xl bg-white/90 p-5 shadow-2xl backdrop-blur-xl border border-white/50 min-w-[320px]"
          data-testid="finalize-success-toast"
        >
          <img src={logo} className="h-12 w-12 object-contain mix-blend-multiply" alt="Success" />
          <div className="flex-1">
            <h4 className="font-bold text-slate-900">Archive Finalized!</h4>
            <p className="text-sm text-slate-600 leading-tight">Your memories are safe and organized.</p>
          </div>
          <button
            onClick={onClose}
            className="ml-2 p-1 text-slate-400 hover:text-slate-600 transition-colors"
            aria-label="Close success toast"
          >
            <span className="text-2xl leading-none">×</span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
