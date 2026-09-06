'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  getBezierPath,
} from 'reactflow'
import 'reactflow/dist/style.css'

// â”€â”€ Color palette â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const TYPE_STYLES = {
  fact:          { color: '#22c55e', bg: 'rgba(34,197,94,0.12)',   border: 'rgba(34,197,94,0.5)',   label: 'FACT',         icon: 'âœ…' },
  hypothesis:    { color: '#eab308', bg: 'rgba(234,179,8,0.12)',   border: 'rgba(234,179,8,0.5)',   label: 'HYPOTHESIS',   icon: 'ðŸŸ¡' },
  contradictory: { color: '#ef4444', bg: 'rgba(239,68,68,0.14)',   border: 'rgba(239,68,68,0.6)',   label: 'CONTRADICTION', icon: 'ðŸ”´' },
  action:        { color: '#3b82f6', bg: 'rgba(59,130,246,0.12)',  border: 'rgba(59,130,246,0.5)',  label: 'ACTION',       icon: 'ðŸ”µ' },
  unknown:       { color: '#94a3b8', bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.4)', label: 'UNKNOWN',      icon: 'âšª' },
}

const TYPE_ORDER = ['fact', 'hypothesis', 'contradictory', 'action', 'unknown']

// â”€â”€ Auto-layout: column-based with even vertical spacing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function computeLayout(claims) {
  // Group by type
  const groups = {}
  for (const t of TYPE_ORDER) groups[t] = []
  for (const c of claims) {
    const t = c.type in groups ? c.type : 'unknown'
    groups[t].push(c)
  }

  const NODE_W = 230
  const NODE_H = 110
  const COL_GAP = 60
  const ROW_GAP = 28

  const positions = {}
  let colX = 20
  for (const t of TYPE_ORDER) {
    const items = groups[t]
    if (!items.length) continue
    items.forEach((c, i) => {
      positions[c.id] = {
        x: colX,
        y: 20 + i * (NODE_H + ROW_GAP),
      }
    })
    colX += NODE_W + COL_GAP
  }
  return positions
}

// â”€â”€ Custom node component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ClaimNode({ data, selected }) {
  const s = TYPE_STYLES[data.type] ?? TYPE_STYLES.unknown
  return (
    <div
      style={{
        background: selected ? s.bg.replace('0.12', '0.22').replace('0.14', '0.26').replace('0.10', '0.20') : s.bg,
        border: `${selected ? 2.5 : 1.5}px solid ${s.border}`,
        borderRadius: 10,
        width: 230,
        padding: '8px 10px',
        boxShadow: selected ? `0 0 0 2px ${s.color}55, 0 4px 20px rgba(0,0,0,0.4)` : '0 2px 10px rgba(0,0,0,0.3)',
        transition: 'all 0.15s ease',
        cursor: 'pointer',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: s.color, width: 8, height: 8 }} />

      {/* Type badge + seq */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
          color: s.color, background: s.color + '22', borderRadius: 4,
          padding: '1px 6px', border: `1px solid ${s.color}44`,
        }}>
          {s.icon} {s.label}
        </span>
        {data.seq != null && (
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)', marginLeft: 'auto', fontFamily: 'monospace' }}>
            #{data.seq}
          </span>
        )}
      </div>

      {/* Claim text */}
      <p style={{
        fontSize: 11, color: 'rgba(255,255,255,0.88)', lineHeight: 1.4,
        margin: '0 0 6px', display: '-webkit-box', WebkitLineClamp: 3,
        WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>
        {data.claim}
      </p>

      {/* Speaker */}
      {data.speaker && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{
            width: 14, height: 14, borderRadius: '50%', background: `linear-gradient(135deg, ${s.color}88, ${s.color}44)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, color: 'white', fontWeight: 700, flexShrink: 0,
          }}>
            {(data.speaker || '?')[0].toUpperCase()}
          </div>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {data.speaker}{data.speakerRole ? ` Â· ${data.speakerRole}` : ''}
          </span>
        </div>
      )}

      {/* Confidence bar */}
      {data.confidence != null && (
        <div style={{ marginTop: 5, height: 2, borderRadius: 1, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
          <div style={{ width: `${Math.round(data.confidence * 100)}%`, height: '100%', background: s.color, opacity: 0.7, borderRadius: 1 }} />
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: s.color, width: 8, height: 8 }} />
    </div>
  )
}

// â”€â”€ Custom edge for CONTRADICTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ConflictEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd }) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  return (
    <>
      <path id={id} style={{ stroke: '#ef4444', strokeWidth: 2.5, strokeDasharray: '6 3', fill: 'none' }} d={edgePath}
        markerEnd={markerEnd} className="react-flow__edge-path" />
      <foreignObject width={80} height={20} x={labelX - 40} y={labelY - 10} style={{ overflow: 'visible' }}>
        <div style={{
          background: 'rgba(239,68,68,0.2)', border: '1px solid rgba(239,68,68,0.5)',
          borderRadius: 4, padding: '1px 5px', fontSize: 9, fontWeight: 700,
          color: '#f87171', letterSpacing: '0.1em', textAlign: 'center', whiteSpace: 'nowrap',
        }}>
          CONTRADICTS
        </div>
      </foreignObject>
    </>
  )
}

// â”€â”€ Support edge (hypothesis â†’ fact) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function SupportEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd }) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  return (
    <>
      <path id={id} style={{ stroke: '#eab308', strokeWidth: 1.5, opacity: 0.45, fill: 'none', strokeDasharray: '4 4' }} d={edgePath}
        markerEnd={markerEnd} className="react-flow__edge-path" />
      <foreignObject width={60} height={16} x={labelX - 30} y={labelY - 8} style={{ overflow: 'visible' }}>
        <div style={{
          background: 'rgba(234,179,8,0.12)', fontSize: 8, color: '#ca8a04',
          letterSpacing: '0.08em', textAlign: 'center', padding: '1px 4px', borderRadius: 3,
        }}>
          relates to
        </div>
      </foreignObject>
    </>
  )
}

const nodeTypes = { claim: ClaimNode }
const edgeTypes = { conflict: ConflictEdge, support: SupportEdge }

// â”€â”€ Main TruthGraph component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function TruthGraph({ claims = [] }) {
  const [selectedId, setSelectedId] = useState(null)

  const positions = useMemo(() => computeLayout(claims), [claims])

  const initialNodes = useMemo(() =>
    claims.map((c) => ({
      id: String(c.id),
      type: 'claim',
      position: positions[c.id] ?? { x: 0, y: 0 },
      data: {
        claim: c.claim || '(no claim text)',
        type: c.type || 'unknown',
        speaker: c.speaker || null,
        speakerRole: c.speakerRole || null,
        speakerUid: c.speakerUid || null,
        seq: c.seq,
        confidence: c.confidence ?? null,
        conflicts_with_seq: c.conflicts_with_seq,
        id: c.id,
      },
      selected: String(c.id) === selectedId,
    })),
    [claims, positions, selectedId]
  )

  const initialEdges = useMemo(() => {
    const edges = []
    const claimBySeq = new Map(claims.map(c => [Number(c.seq), c]))

    // Conflict edges
    for (const c of claims) {
      if (c.conflicts_with_seq == null) continue
      const target = claimBySeq.get(Number(c.conflicts_with_seq))
      if (!target) continue
      edges.push({
        id: `conflict-${c.id}-${target.id}`,
        source: String(c.id),
        target: String(target.id),
        type: 'conflict',
        animated: true,
        markerEnd: { type: 'arrowclosed', color: '#ef4444' },
      })
    }

    // Support edges: connect each hypothesis to the most recent preceding fact from a different speaker
    const facts = claims.filter(c => c.type === 'fact').sort((a, b) => a.timestamp - b.timestamp)
    const hypotheses = claims.filter(c => c.type === 'hypothesis')
    for (const h of hypotheses) {
      const relatedFact = facts.find(f => f.speakerUid !== h.speakerUid && f.timestamp <= h.timestamp)
      if (!relatedFact) continue
      edges.push({
        id: `support-${h.id}-${relatedFact.id}`,
        source: String(h.id),
        target: String(relatedFact.id),
        type: 'support',
        markerEnd: { type: 'arrowclosed', color: '#eab308' },
      })
    }

    return edges
  }, [claims])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // Sync nodes/edges when claims change (new claims arrive via polling)
  useEffect(() => {
    setNodes(initialNodes)
  }, [initialNodes])
  useEffect(() => {
    setEdges(initialEdges)
  }, [initialEdges])

  const onNodeClick = useCallback((_, node) => {
    setSelectedId(prev => prev === node.id ? null : node.id)
  }, [])

  // Selected claim detail
  const selectedClaim = selectedId ? claims.find(c => String(c.id) === selectedId) : null
  const selectedStyle = selectedClaim ? TYPE_STYLES[selectedClaim.type] ?? TYPE_STYLES.unknown : null

  // Stats
  const counts = useMemo(() => {
    const c = { fact: 0, hypothesis: 0, contradictory: 0, action: 0, unknown: 0 }
    for (const cl of claims) if (cl.type in c) c[cl.type]++
    return c
  }, [claims])

  const conflictCount = useMemo(() => claims.filter(c => c.conflicts_with_seq != null).length, [claims])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Stats bar */}
      <div style={{
        display: 'flex', gap: 16, padding: '8px 16px', flexWrap: 'wrap', alignItems: 'center',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(0,0,0,0.2)',
      }}>
        {TYPE_ORDER.map(t => {
          const s = TYPE_STYLES[t]
          return counts[t] > 0 ? (
            <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, display: 'inline-block', flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: s.color, fontWeight: 600 }}>{counts[t]}</span>
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', textTransform: 'capitalize' }}>{t}</span>
            </div>
          ) : null
        })}
        {conflictCount > 0 && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: '#ef4444', display: 'inline-block' }} />
            <span style={{ fontSize: 10, color: '#f87171', fontWeight: 600 }}>{conflictCount} conflict edge{conflictCount > 1 ? 's' : ''}</span>
          </div>
        )}
      </div>

      {/* Graph canvas + detail panel */}
      <div style={{ display: 'flex', minHeight: 480 }}>
        {/* ReactFlow */}
        <div style={{ flex: 1, position: 'relative' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.18, maxZoom: 1.1 }}
            minZoom={0.3}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            style={{ background: 'transparent' }}
          >
            <Background color="#1e293b" gap={24} size={1} />
            <Controls
              style={{ background: 'rgba(15,23,42,0.9)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
              showInteractive={false}
            />
            <MiniMap
              style={{ background: 'rgba(7,17,31,0.95)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}
              nodeColor={(n) => (TYPE_STYLES[n.data?.type] ?? TYPE_STYLES.unknown).color + '99'}
              maskColor="rgba(7,17,31,0.7)"
            />
          </ReactFlow>

          {/* Empty state */}
          {claims.length === 0 && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 8, color: 'rgba(255,255,255,0.2)',
              pointerEvents: 'none',
            }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                <circle cx="12" cy="12" r="3"/><circle cx="4" cy="6" r="2"/><circle cx="20" cy="6" r="2"/>
                <circle cx="4" cy="18" r="2"/><circle cx="20" cy="18" r="2"/>
                <line x1="6" y1="6" x2="10" y2="11"/><line x1="18" y1="6" x2="14" y2="11"/>
                <line x1="6" y1="18" x2="10" y2="13"/><line x1="18" y1="18" x2="14" y2="13"/>
              </svg>
              <p style={{ fontSize: 13, fontWeight: 500 }}>Speak in the incident room to build the Truth Graph</p>
              <p style={{ fontSize: 11 }}>Facts, contradictions, and hypotheses appear as nodes</p>
            </div>
          )}
        </div>

        {/* Detail panel â€” slides in when a node is selected */}
        {selectedClaim && selectedStyle && (
          <div style={{
            width: 260, flexShrink: 0, borderLeft: '1px solid rgba(255,255,255,0.07)',
            background: 'rgba(7,17,31,0.97)', padding: 16, overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: 12,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
                color: selectedStyle.color, background: selectedStyle.color + '22',
                borderRadius: 4, padding: '2px 8px', border: `1px solid ${selectedStyle.color}44`,
              }}>
                {selectedStyle.icon} {selectedStyle.label}
              </span>
              <button
                onClick={() => setSelectedId(null)}
                style={{ color: 'rgba(255,255,255,0.3)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
              >
                Ã—
              </button>
            </div>

            <div>
              <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Claim</p>
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.9)', lineHeight: 1.5 }}>{selectedClaim.claim}</p>
            </div>

            {selectedClaim.speaker && (
              <div>
                <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Speaker</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: '50%', background: `linear-gradient(135deg, ${selectedStyle.color}99, ${selectedStyle.color}44)`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: 'white', fontWeight: 700,
                  }}>
                    {selectedClaim.speaker[0].toUpperCase()}
                  </div>
                  <div>
                    <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', fontWeight: 600 }}>{selectedClaim.speaker}</p>
                    {selectedClaim.speakerRole && <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>{selectedClaim.speakerRole}</p>}
                  </div>
                </div>
              </div>
            )}

            {selectedClaim.confidence != null && (
              <div>
                <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Confidence</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.08)' }}>
                    <div style={{ width: `${Math.round(selectedClaim.confidence * 100)}%`, height: '100%', background: selectedStyle.color, borderRadius: 2 }} />
                  </div>
                  <span style={{ fontSize: 11, color: selectedStyle.color, fontWeight: 600, fontFamily: 'monospace' }}>
                    {Math.round(selectedClaim.confidence * 100)}%
                  </span>
                </div>
              </div>
            )}

            {selectedClaim.conflicts_with_seq != null && (
              <div style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}>
                <p style={{ fontSize: 10, color: '#f87171', fontWeight: 600 }}>âš¡ Contradicts claim #{selectedClaim.conflicts_with_seq}</p>
                <p style={{ fontSize: 10, color: 'rgba(239,68,68,0.6)', marginTop: 2 }}>Red edge shows the conflict link in the graph</p>
              </div>
            )}

            {selectedClaim.seq != null && (
              <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', fontFamily: 'monospace' }}>Sequence: #{selectedClaim.seq}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}


