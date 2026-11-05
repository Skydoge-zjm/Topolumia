import { FAMILY_ORDER, familyColor } from "@/features/topology/model/nodeVisuals";
import styles from "./entry.module.css";

/**
 * A fixed miniature of the research topology: two node-group plots, a free-standing
 * question and the relations between them. Purely illustrative; it carries no data.
 */
const [inquiry, evidence, empirical, reasoning, direction] = FAMILY_ORDER.map(familyColor);

const nodes = [
  { x: 92, y: 70, color: inquiry, w: 120 },
  { x: 300, y: 128, color: evidence, w: 104 },
  { x: 300, y: 184, color: evidence, w: 132 },
  { x: 300, y: 240, color: empirical, w: 112 },
  { x: 520, y: 150, color: reasoning, w: 116 },
  { x: 520, y: 206, color: empirical, w: 96 },
  { x: 520, y: 300, color: direction, w: 124 },
];
const paths = [
  "M152 70 C 220 70, 200 128, 248 128",
  "M152 70 C 210 90, 220 184, 234 184",
  "M356 240 C 420 240, 410 206, 472 206",
  "M366 184 C 420 184, 420 150, 462 150",
  "M578 206 C 620 230, 620 280, 582 300",
];

export function TopologyIllustration() {
  return (
    <svg className={styles.illustration} viewBox="0 0 660 360" aria-hidden="true" focusable="false">
      <rect className={styles.plot} x="222" y="96" width="166" height="176" rx="14" />
      <rect className={styles.plotTag} x="236" y="86" width="74" height="20" rx="10" />
      <rect className={styles.plot} x="444" y="118" width="152" height="120" rx="14" />
      <rect className={styles.plotTag} x="458" y="108" width="62" height="20" rx="10" />
      {paths.map((d, index) => <path key={index} className={styles.relation} d={d} style={{ animationDelay: `${index * -1.1}s` }} />)}
      {nodes.map((node, index) => (
        <g key={index} transform={`translate(${node.x - node.w / 2} ${node.y - 14})`}>
          <rect className={styles.node} width={node.w} height="28" rx="14" />
          <circle cx="14" cy="14" r="5" fill={node.color} />
          <rect x="26" y="11" width={node.w - 40} height="6" rx="3" fill={node.color} opacity="0.22" />
        </g>
      ))}
    </svg>
  );
}
