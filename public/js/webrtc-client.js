// omoggle v2 — thin WebRTC wrapper around the socket.io signaling channel.
window.OmoggleRTC = (() => {
  function createPeer({ socket, localStream, role, onRemoteStream, onClose, iceServers }) {
    const pc = new RTCPeerConnection({
      iceServers: iceServers || [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
      ],
    });
    let closed = false;

    if (localStream) for (const t of localStream.getTracks()) pc.addTrack(t, localStream);

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('rtc:signal', { type: 'ice', candidate: e.candidate });
    };
    pc.ontrack = (e) => {
      onRemoteStream?.(e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && !closed) {
        closed = true;
        onClose?.(pc.connectionState);
      }
    };

    async function handleSignal(msg) {
      try {
        if (msg.type === 'offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(msg));
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          socket.emit('rtc:signal', pc.localDescription.toJSON());
        } else if (msg.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(msg));
        } else if (msg.type === 'ice' && msg.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
      } catch (e) {
        console.warn('signal err', e);
      }
    }

    async function start() {
      if (role === 'caller') {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('rtc:signal', pc.localDescription.toJSON());
      }
    }

    function close() {
      closed = true;
      try { pc.getSenders().forEach(s => s.track && s.track.stop()); } catch {}
      try { pc.close(); } catch {}
    }

    return { pc, handleSignal, start, close };
  }

  return { createPeer };
})();
