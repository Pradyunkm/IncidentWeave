import ReactFlow, { Background, Controls } from 'reactflow'
import 'reactflow/dist/style.css'

const typeColors = {
  fact: '#22c55e',
  hypothesis: '#eab308',
  contradictory: '#ef4444',
  action: '#3b82f6',
  unknown: '#94a3b8',
}

export default function TruthGraph({ claims }) {
  const nodes = claims.map((c, i) => ({
    id: c.id,
    position: { x: (i % 3) * 240 + 40, y: Math.floor(i / 3) * 130 + 40 },
    data: {
      label: `${(c.type || 'unknown').toUpperCase()}\n${(c.claim || '').slice(0, 60)}`,
    },
    style: {
      background: (typeColors[c.type] ?? typeColors.unknown) + '22',
      border: `2px solid ${typeColors[c.type] ?? typeColors.unknown}`,
      borderRadius: 8,
      fontSize: 11,
      width: 210,
      whiteSpace: 'pre-line',
    },
  }))

  // Match conflict edges by seq (integer), using explicit Number() coercion
  // to handle cases where Redis JSON parsing returns strings instead of integers.
  // This is the canonical fix for reliable contradiction linking (no substring matching).
  const edges = claims
    .filter(c => c.conflicts_with_seq != null)
    .map(c => {
      const targetClaim = claims.find(x => Number(x.seq) === Number(c.conflicts_with_seq))
      if (!targetClaim) return null
      return {
        id: `e-${c.id}-${targetClaim.id}`,
        source: c.id,
        target: targetClaim.id,
        style: { stroke: '#ef4444', strokeWidth: 2 },
        label: 'contradicts',
        labelStyle: { fill: '#ef4444', fontSize: 10 },
        animated: true,
      }
    })
    .filter(Boolean)

  return (
    <div style={{ height: 400, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}>
      <ReactFlow nodes={nodes} edges={edges} fitView>
        <Background color="#1e293b" gap={20} />
        <Controls />
      </ReactFlow>
    </div>
  )
}