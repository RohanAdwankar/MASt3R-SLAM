import torch


def _normalize_quat(q):
    return q / q.norm(dim=-1, keepdim=True).clamp_min(1e-12)


def _quat_mul(q1, q2):
    x1, y1, z1, w1 = q1.unbind(dim=-1)
    x2, y2, z2, w2 = q2.unbind(dim=-1)
    return torch.stack(
        (
            w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
            w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
            w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
            w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        ),
        dim=-1,
    )


def _quat_conj(q):
    xyz, w = q[..., :3], q[..., 3:]
    return torch.cat((-xyz, w), dim=-1)


def _quat_to_matrix(q):
    q = _normalize_quat(q)
    x, y, z, w = q.unbind(dim=-1)
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z

    return torch.stack(
        (
            1 - 2 * (yy + zz),
            2 * (xy - wz),
            2 * (xz + wy),
            2 * (xy + wz),
            1 - 2 * (xx + zz),
            2 * (yz - wx),
            2 * (xz - wy),
            2 * (yz + wx),
            1 - 2 * (xx + yy),
        ),
        dim=-1,
    ).reshape(q.shape[:-1] + (3, 3))


def _so3_exp(w):
    theta = w.norm(dim=-1, keepdim=True)
    half_theta = 0.5 * theta
    small = theta < 1e-8
    imag_scale = torch.where(
        small,
        0.5 - theta * theta / 48.0,
        torch.sin(half_theta) / theta.clamp_min(1e-12),
    )
    real = torch.where(
        small,
        1.0 - theta * theta / 8.0,
        torch.cos(half_theta),
    )
    return _normalize_quat(torch.cat((w * imag_scale, real), dim=-1))


class SE3:
    embedded_dim = 7

    def __init__(self, data):
        self.data = data

    @classmethod
    def Identity(cls, n=1, device=None, dtype=torch.float32):
        data = torch.zeros((n, cls.embedded_dim), device=device, dtype=dtype)
        data[..., 6] = 1.0
        return cls(data)

    def to(self, device=None, dtype=None):
        return SE3(self.data.to(device=device, dtype=dtype))

    def cpu(self):
        return self.to("cpu")

    def __getitem__(self, item):
        return SE3(self.data[item])

    def inv(self):
        t = self.data[..., :3]
        q = _normalize_quat(self.data[..., 3:7])
        R_inv = _quat_to_matrix(_quat_conj(q))
        t_inv = -(R_inv @ t.unsqueeze(-1)).squeeze(-1)
        return SE3(torch.cat((t_inv, _quat_conj(q)), dim=-1))

    def __mul__(self, other):
        t1 = self.data[..., :3]
        q1 = _normalize_quat(self.data[..., 3:7])
        t2 = other.data[..., :3]
        q2 = _normalize_quat(other.data[..., 3:7])
        R1 = _quat_to_matrix(q1)
        t = t1 + (R1 @ t2.unsqueeze(-1)).squeeze(-1)
        q = _quat_mul(q1, q2)
        return SE3(torch.cat((t, q), dim=-1))

    def act(self, points):
        t = self.data[..., :3]
        q = _normalize_quat(self.data[..., 3:7])
        R = _quat_to_matrix(q)
        return (R @ points.unsqueeze(-1)).squeeze(-1) + t

    def matrix(self):
        t = self.data[..., :3]
        q = _normalize_quat(self.data[..., 3:7])
        R = _quat_to_matrix(q)
        eye = torch.eye(4, device=self.data.device, dtype=self.data.dtype)
        eye = eye.expand(self.data.shape[:-1] + (4, 4)).clone()
        eye[..., :3, :3] = R
        eye[..., :3, 3] = t
        return eye


class Sim3:
    embedded_dim = 8

    def __init__(self, data):
        self.data = data

    @classmethod
    def Identity(cls, n=1, device=None, dtype=torch.float32):
        data = torch.zeros((n, cls.embedded_dim), device=device, dtype=dtype)
        data[..., 6] = 1.0
        return cls(data)

    def to(self, device=None, dtype=None):
        return Sim3(self.data.to(device=device, dtype=dtype))

    def cpu(self):
        return self.to("cpu")

    def __getitem__(self, item):
        return Sim3(self.data[item])

    def _split(self):
        t = self.data[..., :3]
        q = _normalize_quat(self.data[..., 3:7])
        s = torch.exp(self.data[..., 7:8])
        return t, q, s

    def inv(self):
        t, q, s = self._split()
        q_inv = _quat_conj(q)
        R_inv = _quat_to_matrix(q_inv)
        t_inv = -((R_inv @ t.unsqueeze(-1)).squeeze(-1) / s)
        data = torch.cat((t_inv, q_inv, -self.data[..., 7:8]), dim=-1)
        return Sim3(data)

    def __mul__(self, other):
        t1, q1, s1 = self._split()
        t2, q2, s2 = other._split()
        R1 = _quat_to_matrix(q1)
        t = t1 + s1 * (R1 @ t2.unsqueeze(-1)).squeeze(-1)
        q = _quat_mul(q1, q2)
        data = torch.cat((t, q, torch.log(s1 * s2)), dim=-1)
        return Sim3(data)

    def act(self, points):
        t, q, s = self._split()
        R = _quat_to_matrix(q)
        return s * (R @ points.unsqueeze(-1)).squeeze(-1) + t

    def retr(self, tau):
        dt, w, ds = tau.split((3, 3, 1), dim=-1)
        delta = Sim3(torch.cat((dt, _so3_exp(w), ds), dim=-1))
        return self * delta

    def matrix(self):
        t, q, s = self._split()
        R = _quat_to_matrix(q) * s.unsqueeze(-1)
        eye = torch.eye(4, device=self.data.device, dtype=self.data.dtype)
        eye = eye.expand(self.data.shape[:-1] + (4, 4)).clone()
        eye[..., :3, :3] = R
        eye[..., :3, 3] = t
        return eye
