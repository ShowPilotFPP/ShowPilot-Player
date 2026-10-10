// Converts between FPP's channel-output file for network outputs
// ("universeOutputs", co-universes.json) and the Player's outputs list, so
// xLights FPP Connect "UDP Out" can push the controller list.
//
// FPP universe entry: { active, description, id (universe), startChannel,
//   universeCount, channelCount (per universe), type, address, priority, ... }
// FPP types: 0 E1.31 multicast, 1 E1.31 unicast, 2 E1.31 broadcast,
//            3 Art-Net, 4 DDP raw channel numbers, 5 DDP one-based.

function fromFpp(json) {
  const outs = [];
  const skipped = [];
  const cos = (json && Array.isArray(json.channelOutputs)) ? json.channelOutputs : [];
  for (const co of cos) {
    if (!co || co.type !== 'universes' || !Array.isArray(co.universes)) continue;
    const coOn = co.enabled === undefined || co.enabled === 1 || co.enabled === true;
    for (const u of co.universes) {
      const type = Number(u.type);
      const base = {
        enabled: coOn && (u.active === undefined || u.active === 1 || u.active === true),
        description: String(u.description || ''),
        startChannel: Math.max(1, Number(u.startChannel) || 1),
      };
      if (type === 0 || type === 1) {
        outs.push({ ...base, type: 'e131', multicast: type === 0, ip: type === 1 ? String(u.address || '') : '',
          universe: Number(u.id) || 1, universeCount: Math.max(1, Number(u.universeCount) || 1),
          universeSize: Math.min(512, Math.max(1, Number(u.channelCount) || 512)), priority: Number(u.priority) || 0 });
      } else if (type === 4 || type === 5) {
        const per = Number(u.channelCount) || 0;
        const count = per * Math.max(1, Number(u.universeCount) || 1);
        outs.push({ ...base, type: 'ddp', ip: String(u.address || ''), ddpOneBased: type === 5, channelCount: count || per });
      } else {
        skipped.push({ description: base.description, type, address: u.address || '' });
      }
    }
  }
  return { outputs: outs, skipped };
}

function toFpp(outputs) {
  const universes = (outputs || []).map((o) => {
    const common = { active: o.enabled === false ? 0 : 1, description: o.description || '', startChannel: o.startChannel || 1, priority: o.priority || 0, monitor: 1, deDuplicate: 0 };
    if (o.type === 'ddp') {
      return { ...common, id: 1, universeCount: 1, channelCount: o.channelCount || 0, type: o.ddpOneBased ? 5 : 4, address: o.ip || '' };
    }
    return { ...common, id: o.universe || 1, universeCount: o.universeCount || 1, channelCount: o.universeSize || 512,
      type: o.multicast === false ? 1 : 0, address: o.multicast === false ? (o.ip || '') : '' };
  });
  return { channelOutputs: [{ type: 'universes', enabled: 1, startChannel: 1, channelCount: -1, universes }] };
}

module.exports = { fromFpp, toFpp };
