import { useRef, useEffect, useCallback } from 'react';
import type { NetworkData } from './api';

interface Props {
  data: NetworkData;
  width: number;
  height: number;
  onNodeClick?: (nodeId: number) => void;
}

interface SimNode {
  id: number;
  name: string;
  entity_type: string;
  mention_count: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number;
  fy?: number;
}

interface SimEdge {
  source: number;
  target: number;
  weight: number;
  relationship_type: string;
}

const TYPE_COLORS: Record<string, string> = {
  person: '#6366f1',
  organization: '#f59e0b',
  unknown: '#94a3b8',
};

export default function NetworkGraph({ data, width, height, onNodeClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<SimEdge[]>([]);
  const animRef = useRef<number>(0);
  const dragRef = useRef<{ node: SimNode | null; offsetX: number; offsetY: number }>({ node: null, offsetX: 0, offsetY: 0 });
  const hoveredRef = useRef<SimNode | null>(null);
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });

  // Initialize simulation
  useEffect(() => {
    if (!data.nodes.length) return;

    const cx = width / 2;
    const cy = height / 2;

    nodesRef.current = data.nodes.map((n, i) => ({
      ...n,
      x: cx + (Math.cos(i * 2 * Math.PI / data.nodes.length) * Math.min(width, height) * 0.3),
      y: cy + (Math.sin(i * 2 * Math.PI / data.nodes.length) * Math.min(width, height) * 0.3),
      vx: 0,
      vy: 0,
    }));

    edgesRef.current = data.edges.map(e => ({ ...e }));
    transformRef.current = { x: 0, y: 0, scale: 1 };
  }, [data, width, height]);

  // Simple force simulation step
  const simulate = useCallback(() => {
    const nodes = nodesRef.current;
    const edges = edgesRef.current;
    if (!nodes.length) return;

    const alpha = 0.1;
    const repulsion = 3000;
    const attraction = 0.005;
    const centerForce = 0.01;
    const cx = width / 2;
    const cy = height / 2;

    // Center force
    for (const n of nodes) {
      if (n.fx !== undefined) continue;
      n.vx += (cx - n.x) * centerForce;
      n.vy += (cy - n.y) * centerForce;
    }

    // Repulsion (charge)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = repulsion / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (nodes[i].fx === undefined) { nodes[i].vx -= fx; nodes[i].vy -= fy; }
        if (nodes[j].fx === undefined) { nodes[j].vx += fx; nodes[j].vy += fy; }
      }
    }

    // Attraction (links)
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    for (const e of edges) {
      const a = nodeMap.get(e.source);
      const b = nodeMap.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - 120) * attraction * Math.min(e.weight, 5);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (a.fx === undefined) { a.vx += fx; a.vy += fy; }
      if (b.fx === undefined) { b.vx -= fx; b.vy -= fy; }
    }

    // Apply velocities with damping
    for (const n of nodes) {
      if (n.fx !== undefined) { n.x = n.fx; n.y = n.fy!; continue; }
      n.vx *= 0.6;
      n.vy *= 0.6;
      n.x += n.vx * alpha;
      n.y += n.vy * alpha;
    }
  }, [width, height]);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      simulate();

      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      const nodeMap = new Map(nodes.map(n => [n.id, n]));
      const t = transformRef.current;

      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.scale(t.scale, t.scale);

      // Draw edges
      const maxWeight = Math.max(...edges.map(e => e.weight), 1);
      for (const e of edges) {
        const a = nodeMap.get(e.source);
        const b = nodeMap.get(e.target);
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        const w = Math.max(0.5, (e.weight / maxWeight) * 4);
        ctx.strokeStyle = e.relationship_type === 'affiliation' ? 'rgba(245,158,11,0.4)' : 'rgba(148,163,184,0.25)';
        ctx.lineWidth = w;
        ctx.stroke();
      }

      // Draw nodes
      const hovered = hoveredRef.current;
      const maxMentions = Math.max(...nodes.map(n => n.mention_count), 1);

      for (const n of nodes) {
        const r = Math.max(5, Math.sqrt(n.mention_count / maxMentions) * 20);
        const color = TYPE_COLORS[n.entity_type] || TYPE_COLORS.unknown;

        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = hovered?.id === n.id ? color : color + 'cc';
        ctx.fill();

        if (hovered?.id === n.id) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      // Labels for larger/hovered nodes
      ctx.fillStyle = '#1f2937';
      ctx.textAlign = 'center';
      for (const n of nodes) {
        const r = Math.max(5, Math.sqrt(n.mention_count / maxMentions) * 20);
        if (r > 8 || hovered?.id === n.id) {
          const fontSize = Math.max(9, Math.min(13, r * 0.9));
          ctx.font = `${hovered?.id === n.id ? 'bold ' : ''}${fontSize}px system-ui, sans-serif`;
          ctx.fillText(n.name, n.x, n.y - r - 4);
        }
      }

      ctx.restore();
      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [data, width, height, simulate]);

  // Mouse interaction handlers
  const screenToWorld = useCallback((sx: number, sy: number) => {
    const t = transformRef.current;
    return { x: (sx - t.x) / t.scale, y: (sy - t.y) / t.scale };
  }, []);

  const findNode = useCallback((wx: number, wy: number): SimNode | null => {
    const nodes = nodesRef.current;
    const maxMentions = Math.max(...nodes.map(n => n.mention_count), 1);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const r = Math.max(5, Math.sqrt(n.mention_count / maxMentions) * 20) + 4;
      const dx = wx - n.x;
      const dy = wy - n.y;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const { x, y } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const node = findNode(x, y);
    if (node) {
      dragRef.current = { node, offsetX: x - node.x, offsetY: y - node.y };
      node.fx = node.x;
      node.fy = node.y;
    }
  }, [screenToWorld, findNode]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const { x, y } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

    if (dragRef.current.node) {
      const d = dragRef.current;
      d.node.fx = x - d.offsetX;
      d.node.fy = y - d.offsetY;
    } else {
      hoveredRef.current = findNode(x, y);
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = hoveredRef.current ? 'pointer' : 'default';
    }
  }, [screenToWorld, findNode]);

  const handleMouseUp = useCallback(() => {
    if (dragRef.current.node) {
      dragRef.current.node.fx = undefined;
      dragRef.current.node.fy = undefined;
      dragRef.current = { node: null, offsetX: 0, offsetY: 0 };
    }
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!onNodeClick) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const { x, y } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const node = findNode(x, y);
    if (node) onNodeClick(node.id);
  }, [onNodeClick, screenToWorld, findNode]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const t = transformRef.current;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const zoom = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.max(0.2, Math.min(5, t.scale * zoom));
    t.x = mx - (mx - t.x) * (newScale / t.scale);
    t.y = my - (my - t.y) * (newScale / t.scale);
    t.scale = newScale;
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={handleClick}
      onWheel={handleWheel}
      className="rounded-lg border border-gray-200 bg-white"
    />
  );
}
