import { Check, Circle, LoaderCircle } from "lucide-react";

import { type SshConnection } from "@/features/environments/ssh/ssh";
import styles from "./SshEnvironmentSelector.module.css";
import { working, statusLabel } from "./presentation";

export function Status({
  profile,
  en,
}: {
  profile: SshConnection;
  en: boolean;
}) {
  return (
    <span className={styles.status} data-status={profile.status}>
      {working(profile) ? (
        <LoaderCircle size={12} className={styles.spin} aria-hidden />
      ) : profile.status === "connected" ? (
        <Check size={12} aria-hidden />
      ) : (
        <Circle size={9} aria-hidden />
      )}
      {statusLabel(profile, en)}
    </span>
  );
}
