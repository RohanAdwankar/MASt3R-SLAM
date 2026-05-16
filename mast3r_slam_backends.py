import warnings

import torch
import torch.nn.functional as F


_warned = set()


def _warn_once(key, message):
    if key not in _warned:
        warnings.warn(message)
        _warned.add(key)


def _normalize_grid(points, h, w):
    grid = points.clone()
    grid[..., 0] = 2.0 * grid[..., 0] / max(w - 1, 1) - 1.0
    grid[..., 1] = 2.0 * grid[..., 1] / max(h - 1, 1) - 1.0
    return grid


def _sample_field(field, points):
    b, h, w, c = field.shape
    grid = _normalize_grid(points, h, w).unsqueeze(2)
    sampled = F.grid_sample(
        field.permute(0, 3, 1, 2),
        grid,
        mode="bilinear",
        padding_mode="border",
        align_corners=True,
    )
    return sampled.squeeze(-1).permute(0, 2, 1).contiguous()


def iter_proj(
    rays_img_with_grad,
    pts_3d_norm,
    p_init,
    max_iter,
    lambda_init,
    cost_thresh,
):
    _, h, w, _ = rays_img_with_grad.shape
    p = p_init.to(dtype=rays_img_with_grad.dtype).clone()
    valid = (
        (p[..., 0] >= 0)
        & (p[..., 0] <= w - 1)
        & (p[..., 1] >= 0)
        & (p[..., 1] <= h - 1)
    )

    for _ in range(max_iter):
        sample = _sample_field(rays_img_with_grad, p)
        rays = sample[..., 0:3]
        gx = sample[..., 3:6]
        gy = sample[..., 6:9]

        residual = rays - pts_3d_norm
        jtj_00 = (gx * gx).sum(dim=-1) + lambda_init
        jtj_01 = (gx * gy).sum(dim=-1)
        jtj_11 = (gy * gy).sum(dim=-1) + lambda_init
        jtr_0 = (gx * residual).sum(dim=-1)
        jtr_1 = (gy * residual).sum(dim=-1)

        det = jtj_00 * jtj_11 - jtj_01 * jtj_01
        det = torch.where(det.abs() < 1e-9, torch.full_like(det, 1e-9), det)

        delta_x = (-jtj_11 * jtr_0 + jtj_01 * jtr_1) / det
        delta_y = (jtj_01 * jtr_0 - jtj_00 * jtr_1) / det
        delta = torch.stack((delta_x, delta_y), dim=-1)

        p = p + delta
        p[..., 0].clamp_(0, w - 1)
        p[..., 1].clamp_(0, h - 1)

        valid = valid & torch.isfinite(delta).all(dim=-1)
        if delta.norm(dim=-1).amax().item() < cost_thresh:
            break

    return p, valid


def refine_matches(D11, D21, p1, window_size, dilation_max):
    _warn_once(
        "refine_matches",
        "Using pure-Torch fallback for refine_matches; local descriptor refinement is disabled.",
    )
    return [p1]


def gauss_newton_points(*args, **kwargs):
    _warn_once(
        "gauss_newton_points",
        "Using pure-Torch fallback backend; global point optimization is disabled on this device.",
    )
    return []


def gauss_newton_rays(*args, **kwargs):
    _warn_once(
        "gauss_newton_rays",
        "Using pure-Torch fallback backend; global ray optimization is disabled on this device.",
    )
    return []


def gauss_newton_calib(*args, **kwargs):
    _warn_once(
        "gauss_newton_calib",
        "Using pure-Torch fallback backend; global calibrated optimization is disabled on this device.",
    )
    return []
