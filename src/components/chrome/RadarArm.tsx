"use client";

// Headless: resumes the radar hunter when the stored intent says it was
// armed. Rides the shell for the same reason the alert monitor does — a
// hunter that only hunted while its own page was open would be a launch
// ticker, not a radar. Renders nothing; the /radar page is the face.

import { useEffect } from "react";
import { resumeHuntingIfArmed } from "@/lib/radar/hunter";

export function RadarArm() {
  // Starting an external system from an effect is the sanctioned direction;
  // no state is set here.
  useEffect(() => {
    resumeHuntingIfArmed();
  }, []);
  return null;
}
