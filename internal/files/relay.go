package files

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// The Storage relay. File bytes never travel through Firestore; they go through
// Firebase Storage under projectbv/files/, AES-GCM sealed so the world-readable
// bucket only ever holds opaque blobs. The dashboard reads/writes the same paths.
//
// The agent has no Firebase auth, so these requests are unauthenticated — which
// is why the Storage rules open projectbv/files/ (with a size cap). The seal is
// what actually protects the contents.

const storageBase = "https://firebasestorage.googleapis.com/v0/b/"

func objURL(objectPath string) string {
	return storageBase + StorageBucket + "/o/" + url.QueryEscape(objectPath)
}

// uploadObject PUTs sealed bytes to objectPath (device → dashboard).
func uploadObject(ctx context.Context, hc *http.Client, objectPath string, data []byte) error {
	u := storageBase + StorageBucket + "/o?name=" + url.QueryEscape(objectPath)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("storage upload HTTP %d: %s", resp.StatusCode, bytes.TrimSpace(b))
	}
	return nil
}

// downloadObject GETs the raw bytes of objectPath (dashboard → device).
func downloadObject(ctx context.Context, hc *http.Client, objectPath string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, objURL(objectPath)+"?alt=media", nil)
	if err != nil {
		return nil, err
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("storage download HTTP %d: %s", resp.StatusCode, bytes.TrimSpace(b))
	}
	return io.ReadAll(resp.Body)
}

// deleteObject removes a relay blob once it has been consumed.
func deleteObject(ctx context.Context, hc *http.Client, objectPath string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, objURL(objectPath), nil)
	if err != nil {
		return err
	}
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 2048))
	return nil
}
