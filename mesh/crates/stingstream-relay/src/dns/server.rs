//! The authoritative DNS listener for Full mode.
//!
//! One UDP socket and one TCP listener on the same port. A query for a name inside
//! `direct.<host>` is answered from [`Zone`]; anything else is forwarded to the embedded
//! `iroh-dns-server` on loopback (which serves pkarr discovery for the same host), or refused if
//! that is not running.
//!
//! Forwarding rather than running two servers on two ports is what lets the coordinator hold **one**
//! delegation: `direct.<host>` and the pkarr names live behind a single NS record, and neither
//! knows about the other.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use hickory_proto::op::{Message, MessageType, OpCode, ResponseCode};
use hickory_proto::rr::rdata::{A, AAAA, NS, SOA, TXT};
use hickory_proto::rr::{DNSClass, Name, RData, Record, RecordType};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UdpSocket};

use super::{Answer, QType, Zone, ZoneRecord};
use crate::registry::NodeRegistry;

/// The largest reply we will put in a UDP datagram before setting TC and asking for TCP.
const UDP_MAX: usize = 512;
/// Largest query we will read at all.
const MAX_QUERY: usize = 4096;
/// How long one DNS-over-TCP exchange may take, from accept to the last byte of the reply.
///
/// A resolver that has opened a connection sends its query immediately — it opened the connection
/// *to* send it. Anything that connects and then says nothing, or sends one byte of a two-byte
/// length prefix, is not a resolver, and without this the task blocked in `read_exact` waits for
/// ever on a public port. Ten seconds is longer than any resolver's own timeout, so a slow but real
/// client is never cut off by it.
const TCP_EXCHANGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Where a query that this zone does not own should go.
#[derive(Debug, Clone, Copy)]
pub enum Fallback {
    /// Answer REFUSED. Correct when nothing else is running.
    Refuse,
    /// Forward to another resolver on loopback — the embedded `iroh-dns-server`.
    Forward(SocketAddr),
}

/// Everything the responder needs.
#[derive(Debug, Clone)]
pub struct Responder {
    pub zone: Arc<Zone>,
    pub registry: Arc<NodeRegistry>,
    pub fallback: Fallback,
}

fn qtype_of(rt: RecordType) -> QType {
    match rt {
        RecordType::A => QType::A,
        RecordType::AAAA => QType::Aaaa,
        RecordType::TXT => QType::Txt,
        RecordType::NS => QType::Ns,
        RecordType::SOA => QType::Soa,
        _ => QType::Other,
    }
}

impl Responder {
    /// Turn a wire-format query into a wire-format reply.
    ///
    /// Returns `None` when the bytes are not a parseable DNS message at all, which is the one case
    /// where the right answer is silence rather than an error reply.
    pub async fn respond(&self, query: &[u8]) -> Option<Vec<u8>> {
        let request = match Message::from_vec(query) {
            Ok(m) => m,
            Err(e) => {
                tracing::debug!(error = %e, "dropping an unparseable DNS query");
                return None;
            }
        };
        let id = request.metadata.id;
        let op = request.metadata.op_code;
        if op != OpCode::Query || request.metadata.message_type != MessageType::Query {
            return Message::error_msg(id, op, ResponseCode::NotImp).to_vec().ok();
        }
        let Some(q) = request.queries.first().cloned() else {
            return Message::error_msg(id, op, ResponseCode::FormErr).to_vec().ok();
        };

        let name = q.name().to_ascii();
        let answer = self.zone.lookup(&name, qtype_of(q.query_type()), &self.registry);

        if matches!(answer, Answer::NotInZone) {
            return match self.fallback {
                Fallback::Refuse => Message::error_msg(id, op, ResponseCode::Refused).to_vec().ok(),
                Fallback::Forward(upstream) => match forward(query, upstream).await {
                    Ok(bytes) => Some(bytes),
                    Err(e) => {
                        tracing::warn!(%upstream, error = %e, "forwarding a DNS query failed");
                        Message::error_msg(id, op, ResponseCode::ServFail).to_vec().ok()
                    }
                },
            };
        }

        let mut reply = Message::response(id, op);
        reply.metadata.authoritative = true;
        reply.metadata.recursion_desired = request.metadata.recursion_desired;
        reply.metadata.recursion_available = false;
        reply.add_query(q.clone());

        match answer {
            Answer::NameError => {
                reply.metadata.response_code = ResponseCode::NXDomain;
                if let Some(soa) = self.soa_record() {
                    reply.add_authority(soa);
                }
            }
            Answer::Records(records) => {
                let owner = q.name().clone();
                for r in records {
                    if let Some(record) = self.to_record(&owner, r) {
                        reply.add_answer(record);
                    }
                }
                // NODATA also carries the SOA, so a resolver can cache the negative answer.
                if reply.answers.is_empty() {
                    if let Some(soa) = self.soa_record() {
                        reply.add_authority(soa);
                    }
                }
            }
            Answer::NotInZone => unreachable!("handled above"),
        }
        reply.to_vec().ok()
    }

    fn to_record(&self, owner: &Name, r: ZoneRecord) -> Option<Record> {
        let ttl = self.zone.ttl;
        let rdata = match r {
            ZoneRecord::A(v4) => RData::A(A(v4)),
            ZoneRecord::Aaaa(v6) => RData::AAAA(AAAA(v6)),
            ZoneRecord::Txt(t) => RData::TXT(TXT::new(vec![t])),
            ZoneRecord::Ns(n) => RData::NS(NS(name(&n)?)),
            ZoneRecord::Soa => return self.soa_record(),
        };
        let mut rec = Record::from_rdata(owner.clone(), ttl, rdata);
        rec.dns_class = DNSClass::IN;
        Some(rec)
    }

    fn soa_record(&self) -> Option<Record> {
        let origin = name(&self.zone.origin)?;
        let mname = self
            .zone
            .ns_names
            .first()
            .and_then(|n| name(n))
            .unwrap_or_else(|| origin.clone());
        let rname = name(&self.zone.soa_rname).unwrap_or_else(|| origin.clone());
        // A serial derived from the day means a secondary sees the zone change at most daily, which
        // is right for a zone whose contents are computed rather than edited.
        let serial = (crate::state::now_unix() / 86_400) as u32;
        let soa = SOA::new(mname, rname, serial, 7200, 3600, 1_209_600, self.zone.ttl);
        let mut rec = Record::from_rdata(origin, self.zone.ttl, RData::SOA(soa));
        rec.dns_class = DNSClass::IN;
        Some(rec)
    }
}

fn name(s: &str) -> Option<Name> {
    Name::from_utf8(format!("{}.", s.trim_end_matches('.'))).ok()
}

async fn forward(query: &[u8], upstream: SocketAddr) -> Result<Vec<u8>> {
    let sock = UdpSocket::bind(if upstream.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    })
    .await
    .context("binding a forwarding socket")?;
    sock.send_to(query, upstream)
        .await
        .context("forwarding a query")?;
    let mut buf = vec![0u8; 4096];
    let (n, _) = tokio::time::timeout(std::time::Duration::from_secs(3), sock.recv_from(&mut buf))
        .await
        .context("upstream did not answer in time")?
        .context("reading the upstream answer")?;
    buf.truncate(n);
    Ok(buf)
}

/// Serve UDP and TCP on `bind` until the process stops.
pub async fn serve(responder: Responder, bind: SocketAddr) -> Result<()> {
    let udp = UdpSocket::bind(bind)
        .await
        .with_context(|| format!("binding DNS/UDP to {bind}"))?;
    let tcp = TcpListener::bind(bind)
        .await
        .with_context(|| format!("binding DNS/TCP to {bind}"))?;
    tracing::info!(%bind, origin = %responder.zone.origin, "authoritative DNS listening");

    let udp = Arc::new(udp);
    let udp_task = {
        let responder = responder.clone();
        let udp = udp.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; MAX_QUERY];
            loop {
                let (n, peer) = match udp.recv_from(&mut buf).await {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(error = %e, "DNS/UDP receive failed");
                        continue;
                    }
                };
                let query = buf[..n].to_vec();
                let responder = responder.clone();
                let udp = udp.clone();
                tokio::spawn(async move {
                    if let Some(mut reply) = responder.respond(&query).await {
                        if reply.len() > UDP_MAX {
                            // Too big for a plain datagram: set TC so the resolver retries on TCP.
                            if let Ok(msg) = Message::from_vec(&reply) {
                                if let Ok(t) = msg.truncate().to_vec() {
                                    reply = t;
                                }
                            }
                        }
                        let _ = udp.send_to(&reply, peer).await;
                    }
                });
            }
        })
    };

    let tcp_task = tokio::spawn(async move {
        loop {
            let (mut stream, _peer) = match tcp.accept().await {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "DNS/TCP accept failed");
                    continue;
                }
            };
            let responder = responder.clone();
            tokio::spawn(async move {
                // One timeout around the whole exchange rather than one per read: the reply is
                // written to the same socket, so a client that connects and then refuses to read
                // pins this task just as effectively as one that refuses to write.
                let exchange = async {
                    // DNS over TCP frames each message with a two-byte length.
                    let mut len = [0u8; 2];
                    if stream.read_exact(&mut len).await.is_err() {
                        return;
                    }
                    let len = u16::from_be_bytes(len) as usize;
                    if len > MAX_QUERY {
                        return;
                    }
                    let mut query = vec![0u8; len];
                    if stream.read_exact(&mut query).await.is_err() {
                        return;
                    }
                    if let Some(reply) = responder.respond(&query).await {
                        let _ = stream
                            .write_all(&(reply.len() as u16).to_be_bytes())
                            .await;
                        let _ = stream.write_all(&reply).await;
                        let _ = stream.flush().await;
                    }
                };
                // Timing out drops the future and with it the stream, which closes the connection.
                let _ = tokio::time::timeout(TCP_EXCHANGE_TIMEOUT, exchange).await;
            });
        }
    });

    let _ = tokio::try_join!(udp_task, tcp_task);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hickory_proto::op::Query;

    fn responder() -> Responder {
        Responder {
            zone: Arc::new(Zone {
                origin: "direct.localhost".into(),
                public_ips: vec!["203.0.113.7".parse().unwrap()],
                ns_names: vec!["ns1.example.org".into()],
                soa_rname: "hostmaster.example.org".into(),
                ttl: 300,
            }),
            registry: Arc::new(NodeRegistry::default()),
            fallback: Fallback::Refuse,
        }
    }

    fn query_bytes(name: &str, rt: RecordType) -> Vec<u8> {
        let mut m = Message::new(0x1234, MessageType::Query, OpCode::Query);
        let mut q = Query::new();
        q.set_name(Name::from_utf8(format!("{name}.")).unwrap());
        q.set_query_type(rt);
        m.add_query(q);
        m.to_vec().unwrap()
    }

    fn node() -> String {
        "y".repeat(52)
    }

    /// The acceptance case, end to end through the wire format.
    #[tokio::test]
    async fn the_zone_answers_a_dashed_ip_query_over_the_wire() {
        let r = responder();
        let name = format!("192-168-1-5.{}.direct.localhost", node());
        let reply = r.respond(&query_bytes(&name, RecordType::A)).await.unwrap();
        let msg = Message::from_vec(&reply).unwrap();

        assert_eq!(msg.metadata.id, 0x1234);
        assert!(msg.metadata.authoritative);
        assert_eq!(msg.metadata.response_code, ResponseCode::NoError);
        assert_eq!(msg.answers.len(), 1);
        assert_eq!(
            &msg.answers[0].data,
            &RData::A(A("192.168.1.5".parse().unwrap()))
        );
        assert_eq!(msg.answers[0].name.to_ascii().trim_end_matches('.'), name);
        assert_eq!(msg.answers[0].ttl, 300);
    }

    #[tokio::test]
    async fn an_unknown_name_in_the_zone_is_nxdomain_with_a_soa() {
        let r = responder();
        let reply = r
            .respond(&query_bytes("nope.direct.localhost", RecordType::A))
            .await
            .unwrap();
        let msg = Message::from_vec(&reply).unwrap();
        assert_eq!(msg.metadata.response_code, ResponseCode::NXDomain);
        assert!(msg.answers.is_empty());
        assert_eq!(msg.authorities.len(), 1, "a negative answer carries the SOA so it can be cached");
    }

    #[tokio::test]
    async fn a_name_outside_the_zone_is_refused_when_there_is_no_upstream() {
        let r = responder();
        let reply = r.respond(&query_bytes("example.com", RecordType::A)).await.unwrap();
        let msg = Message::from_vec(&reply).unwrap();
        assert_eq!(msg.metadata.response_code, ResponseCode::Refused);
    }

    #[tokio::test]
    async fn the_apex_answers_soa_and_ns() {
        let r = responder();
        let soa = Message::from_vec(
            &r.respond(&query_bytes("direct.localhost", RecordType::SOA))
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(matches!(soa.answers[0].data, RData::SOA(_)));

        let ns = Message::from_vec(
            &r.respond(&query_bytes("direct.localhost", RecordType::NS))
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(matches!(ns.answers[0].data, RData::NS(_)));
    }

    #[tokio::test]
    async fn a_registered_lan_name_is_answered() {
        let r = responder();
        let n = node();
        r.registry.set_address(&n, "lan", "192.168.1.20".parse().unwrap()).unwrap();
        let reply = r
            .respond(&query_bytes(&format!("lan.{n}.direct.localhost"), RecordType::A))
            .await
            .unwrap();
        let msg = Message::from_vec(&reply).unwrap();
        assert_eq!(
            &msg.answers[0].data,
            &RData::A(A("192.168.1.20".parse().unwrap()))
        );
    }

    #[tokio::test]
    async fn an_acme_token_is_answered_as_txt() {
        let r = responder();
        let n = node();
        r.registry.add_acme_token(&n, "challenge-value").unwrap();
        let reply = r
            .respond(&query_bytes(
                &format!("_acme-challenge.{n}.direct.localhost"),
                RecordType::TXT,
            ))
            .await
            .unwrap();
        let msg = Message::from_vec(&reply).unwrap();
        assert_eq!(msg.answers.len(), 1);
        match &msg.answers[0].data {
            RData::TXT(t) => assert_eq!(t.to_string(), "challenge-value"),
            other => panic!("expected TXT, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn garbage_is_dropped_rather_than_answered() {
        let r = responder();
        assert!(r.respond(b"not a dns message at all").await.is_none());
        assert!(r.respond(&[]).await.is_none());
    }

    #[tokio::test]
    async fn a_query_for_the_wrong_type_at_a_real_name_is_nodata_not_nxdomain() {
        let r = responder();
        let name = format!("192-168-1-5.{}.direct.localhost", node());
        let reply = r.respond(&query_bytes(&name, RecordType::AAAA)).await.unwrap();
        let msg = Message::from_vec(&reply).unwrap();
        assert_eq!(msg.metadata.response_code, ResponseCode::NoError);
        assert!(msg.answers.is_empty());
        assert_eq!(msg.authorities.len(), 1);
    }
}
