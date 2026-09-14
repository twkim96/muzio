package httpserver

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// Pin resolved public addresses in the dialer, including redirected requests.
// Server caching accepts public HTTP(S) origins only; it never forwards client credentials.
func hlsStatusClient() *http.Client {
	transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		for _, ip := range ips {
			if !publicHLSAddress(ip.IP) {
				return nil, errors.New("non-public HLS host")
			}
		}
		for _, ip := range ips {
			conn, err := (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
			if err == nil {
				return conn, nil
			}
		}
		return nil, errors.New("unreachable HLS host")
	}}
	return &http.Client{Transport: transport, Timeout: 8 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 || req.URL.User != nil || (req.URL.Scheme != "http" && req.URL.Scheme != "https") {
			return errors.New("unsupported redirect")
		}
		return nil
	}}
}
func probeHLSStatus(ctx context.Context, raw string) (string, string) {
	client := hlsStatusClient()
	defer client.CloseIdleConnections()
	return probeHLSWithClient(ctx, raw, client)
}
func probeHLSWithClient(ctx context.Context, raw string, client *http.Client) (string, string) {
	for depth := 0; depth < 3; depth++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
		if err != nil {
			return "unknown", ""
		}
		response, err := client.Do(req)
		if err != nil {
			return "unknown", ""
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
		response.Body.Close()
		if err != nil || response.StatusCode != 200 || len(data) > 1<<20 || !strings.HasPrefix(strings.TrimSpace(string(data)), "#EXTM3U") {
			return "unknown", ""
		}
		text := string(data)
		if strings.Contains(text, "#EXTINF:") {
			if strings.Contains(text, "#EXT-X-ENDLIST") {
				return "ended", ""
			}
			sum := sha256.Sum256(data)
			return "live", hex.EncodeToString(sum[:])
		}
		next := ""
		variant := false
		for _, line := range strings.Split(text, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "#EXT-X-STREAM-INF:") {
				variant = true
				continue
			}
			if variant && line != "" && !strings.HasPrefix(line, "#") {
				next = line
				break
			}
		}
		relative, err := url.Parse(next)
		if err != nil || next == "" {
			return "unknown", ""
		}
		resolved := response.Request.URL.ResolveReference(relative)
		if resolved.User != nil {
			return "unknown", ""
		}
		raw = resolved.String()
	}
	return "unknown", ""
}

func publicHLSAddress(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
		return false
	}
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	address = address.Unmap()
	for _, raw := range []string{"100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "64:ff9b::/96", "2001:db8::/32", "2002::/16"} {
		if netip.MustParsePrefix(raw).Contains(address) {
			return false
		}
	}
	return true
}
